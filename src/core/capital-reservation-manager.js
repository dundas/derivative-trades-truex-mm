const TERMINAL_STATES = new Set([
  'rejected', 'cancelled', 'expired', 'filled', 'terminal-evidence-gap',
  'rest-absence-evidence-gap', 'cancel-unknown-evidence-gap',
]);
const SIDES = new Set(['buy', 'sell']);
const EPSILON = 1e-10;

function finiteNonNegative(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return number;
}

function normalizeBalance(balance, field) {
  const available = finiteNonNegative(balance?.available ?? 0, `${field}.available`);
  const held = finiteNonNegative(balance?.held ?? 0, `${field}.held`);
  const total = finiteNonNegative(balance?.total ?? available + held, `${field}.total`);
  if (available + held > total + EPSILON) {
    throw new Error(`${field} available plus held cannot exceed total`);
  }
  return { available, held, total };
}

function reservationAmount(order) {
  return order.side === 'sell' ? order.remainingSize : order.remainingSize * order.price;
}

/**
 * Authoritative local view of exchange balances and maker order reservations.
 * Exchange `available` already excludes venue `held`; only reservations not
 * proven represented by a fresh live-order/held snapshot are subtracted.
 */
export class CapitalReservationManager {
  constructor({
    l1ReserveBase = 0,
    l1ReserveQuote = 0,
    minimumFundedQuoteSize = 0,
    maxTerminalReservations = 10000,
  } = {}) {
    this.l1Reserve = {
      base: finiteNonNegative(l1ReserveBase, 'l1ReserveBase'),
      quote: finiteNonNegative(l1ReserveQuote, 'l1ReserveQuote'),
    };
    this.minimumFundedQuoteSize = finiteNonNegative(minimumFundedQuoteSize, 'minimumFundedQuoteSize');
    if (!Number.isInteger(maxTerminalReservations) || maxTerminalReservations < 1) {
      throw new Error('maxTerminalReservations must be a positive integer');
    }
    this.maxTerminalReservations = maxTerminalReservations;
    this.balances = {
      base: { available: 0, held: 0, total: 0 },
      quote: { available: 0, held: 0, total: 0 },
    };
    this.initialized = false;
    this.reservations = new Map();
    this.consumedEvents = [];
    this.processedExecutions = new Map();
    this.blockedSides = new Map();
    this.terminalReservations = [];
    this.eventSequence = 0;
    this.reconciliationSequence = 0;
    this.lastAppliedReconciliation = 0;
    this.pendingEvidenceGap = null;
    this.state = 'uninitialized';
    this.reason = 'balance-snapshot-required';
  }

  beginReconciliation() {
    const knownOrders = new Map();
    const knownPendingOrders = new Map();
    for (const order of this.reservations.values()) {
      if (!TERMINAL_STATES.has(order.state) && order.acknowledgedLive) {
        knownOrders.set(order.orderId, {
          orderId: order.orderId,
          side: order.side,
          amount: reservationAmount(order),
          acknowledgedLive: true,
        });
      } else if (!TERMINAL_STATES.has(order.state) &&
          (order.state === 'pending-new' || order.state === 'replacement-pending-new')) {
        knownPendingOrders.set(order.orderId, {
          orderId: order.orderId,
          side: order.side,
          price: order.price,
          size: order.remainingSize,
          amount: reservationAmount(order),
        });
      }
    }
    return {
      id: ++this.reconciliationSequence,
      eventSequence: this.eventSequence,
      knownOrders,
      knownPendingOrders,
    };
  }

  reconcile({ baseBalance, quoteBalance, liveOrders = [], clearBlockedSides = false, generation = null }) {
    if (generation && generation.id <= this.lastAppliedReconciliation) return this.getStatus();
    this.balances = {
      base: normalizeBalance(baseBalance, 'baseBalance'),
      quote: normalizeBalance(quoteBalance, 'quoteBalance'),
    };
    this.initialized = true;

    const liveIds = new Set(liveOrders.map((order) => order?.orderId).filter(Boolean));
    const liveByOrderId = new Map();
    for (const live of liveOrders) {
      if (!live?.orderId) continue;
      const matches = liveByOrderId.get(live.orderId) || [];
      matches.push(live);
      liveByOrderId.set(live.orderId, matches);
    }
    const promotedOrderIds = [];
    const promotionMismatches = [];
    if (generation?.knownPendingOrders) {
      for (const [orderId, known] of generation.knownPendingOrders) {
        const current = this.reservations.get(orderId);
        if (!current || current.acknowledgedLive || current.lastMutationSequence > generation.eventSequence ||
            !['pending-new', 'replacement-pending-new'].includes(current.state)) continue;
        const candidates = liveByOrderId.get(orderId) || [];
        if (candidates.length === 0) continue;
        const live = candidates[0];
        const exactMatch = candidates.length === 1 && live.status === 'ACTIVE' &&
          live.promotionEvidenceValid === true &&
          live.localOrderMatches === true && live.side === known.side &&
          Number.isFinite(Number(live.price)) && Math.abs(Number(live.price) - known.price) <= EPSILON &&
          Number.isFinite(Number(live.size)) && Math.abs(Number(live.size) - known.size) <= EPSILON;
        if (!exactMatch) {
          promotionMismatches.push({ orderId, side: known.side, reason: 'live-order-promotion-evidence-mismatch' });
          continue;
        }
        current.state = 'active';
        current.acknowledgedLive = true;
        current.lastMutationSequence = this._nextEvent();
        promotedOrderIds.push(orderId);
      }
    }
    const coveredAtRequest = new Set();
    const coverageByAsset = { base: [], quote: [] };
    if (generation) {
      for (const [orderId, known] of generation.knownOrders) {
        if (liveIds.has(orderId)) coverageByAsset[known.side === 'sell' ? 'base' : 'quote'].push(known);
      }
      for (const orderId of promotedOrderIds) {
        const known = generation.knownPendingOrders.get(orderId);
        coverageByAsset[known.side === 'sell' ? 'base' : 'quote'].push(known);
      }
    }

    const heldShortfallByAsset = { base: false, quote: false };
    for (const asset of ['base', 'quote']) {
      const knownRequired = coverageByAsset[asset].reduce((sum, order) => sum + order.amount, 0);
      if (knownRequired <= this.balances[asset].held + EPSILON) {
        for (const order of coverageByAsset[asset]) coveredAtRequest.add(order.orderId);
      } else if (knownRequired > EPSILON) {
        heldShortfallByAsset[asset] = true;
      }
    }

    for (const reservation of this.reservations.values()) {
      reservation.representedByHeld = false;
      const existedAndWasLiveAtRequest = generation?.knownOrders.has(reservation.orderId);
      const mutatedAfterRequest = generation && reservation.lastMutationSequence > generation.eventSequence;
      if (!TERMINAL_STATES.has(reservation.state) && reservation.acknowledgedLive && !liveIds.has(reservation.orderId) &&
          (!generation || (existedAndWasLiveAtRequest && !mutatedAfterRequest))) {
        reservation.state = 'cancelled';
        reservation.acknowledgedLive = false;
        reservation.remainingSize = 0;
        this._recordTerminal(reservation);
      }
      if (!TERMINAL_STATES.has(reservation.state) && coveredAtRequest.has(reservation.orderId)) {
        reservation.representedByHeld = true;
      }
    }

    if (!generation) {
      const liveByAsset = { base: [], quote: [] };
      for (const orderId of liveIds) {
        const reservation = this.reservations.get(orderId);
        if (!reservation || TERMINAL_STATES.has(reservation.state)) continue;
        liveByAsset[reservation.side === 'sell' ? 'base' : 'quote'].push(reservation);
      }
      for (const asset of ['base', 'quote']) {
        const required = liveByAsset[asset].reduce((sum, order) => sum + reservationAmount(order), 0);
        if (required <= this.balances[asset].held + EPSILON) {
          for (const order of liveByAsset[asset]) order.representedByHeld = true;
        } else if (required > EPSILON) {
          heldShortfallByAsset[asset] = true;
        }
      }
    }

    this.consumedEvents = generation
      ? this.consumedEvents.filter((event) =>
          event.sequence > generation.eventSequence && !coveredAtRequest.has(event.orderId))
      : [];

    if (clearBlockedSides) {
      const coveredSequence = generation?.eventSequence ?? this.eventSequence;
      for (const [side, blockedAt] of this.blockedSides) {
        const asset = side === 'sell' ? 'base' : 'quote';
        if (blockedAt <= coveredSequence && !heldShortfallByAsset[asset]) this.blockedSides.delete(side);
      }
    }
    for (const mismatch of promotionMismatches) {
      if (!this.blockedSides.has(mismatch.side)) {
        this.blockedSides.set(mismatch.side, this._nextEvent());
      }
    }
    const heldShortfall = heldShortfallByAsset.base || heldShortfallByAsset.quote;
    this.state = heldShortfall ? 'degraded' : 'normal';
    this.reason = heldShortfall ? 'rest-held-below-live-reservations' : null;
    if (this.blockedSides.size > 0) {
      this.state = 'degraded';
      this.reason ||= 'insufficient-funds-resync-required';
    }
    if (promotionMismatches.length > 0) {
      this.state = 'degraded';
      this.reason = 'live-order-promotion-evidence-mismatch';
    }
    if (this.state === 'normal' && this.blockedSides.size === 0) {
      for (const order of this.reservations.values()) delete order.evidenceGapReason;
    }
    if (generation) this.lastAppliedReconciliation = generation.id;
    return { ...this.getStatus(), promotedOrderIds, promotionMismatches };
  }

  reserve({ orderId, side, price, size, level = null, replacesOrderId = null }) {
    if (this.state === 'failed') return { accepted: false, reason: 'capital-reconciliation-failed' };
    if (!orderId || this.reservations.has(orderId)) return { accepted: false, reason: 'duplicate-order-id' };
    if (!SIDES.has(side)) return { accepted: false, reason: 'invalid-side' };
    if (this.blockedSides.has(side)) return { accepted: false, reason: 'insufficient-funds-resync-required' };
    const normalizedPrice = finiteNonNegative(price, 'price');
    const normalizedSize = finiteNonNegative(size, 'size');
    if (normalizedPrice <= 0 || normalizedSize <= 0) return { accepted: false, reason: 'invalid-order-value' };
    if (normalizedSize < this.minimumFundedQuoteSize) {
      return { accepted: false, reason: 'below-minimum-funded-quote-size' };
    }
    const required = side === 'sell' ? normalizedSize : normalizedSize * normalizedPrice;
    const available = this.getAvailableForLevel(side, level);
    if (required > available + EPSILON) {
      return { accepted: false, reason: 'locally-unfunded', available };
    }
    const sequence = this._nextEvent();
    this.reservations.set(orderId, {
      orderId,
      side,
      price: normalizedPrice,
      originalSize: normalizedSize,
      remainingSize: normalizedSize,
      level,
      state: replacesOrderId ? 'replacement-pending-new' : 'pending-new',
      replacesOrderId,
      acknowledgedLive: false,
      representedByHeld: false,
      createdSequence: sequence,
      lastMutationSequence: sequence,
    });
    return { accepted: true, orderId };
  }

  accept(orderId) {
    const order = this.reservations.get(orderId);
    if (!order || TERMINAL_STATES.has(order.state) || order.state === 'active') return false;
    if (order.state === 'cancel-in-flight') {
      order.acknowledgedLive = true;
      order.lastMutationSequence = this._nextEvent();
      return false;
    }
    order.state = 'active';
    order.acknowledgedLive = true;
    order.lastMutationSequence = this._nextEvent();
    return true;
  }

  cancelRequested(orderId) {
    const order = this.reservations.get(orderId);
    if (!order || TERMINAL_STATES.has(order.state) || order.state === 'cancel-in-flight') return false;
    order.state = 'cancel-in-flight';
    order.lastMutationSequence = this._nextEvent();
    return true;
  }

  cancelDispatchFailed(orderId, priorState) {
    const order = this.reservations.get(orderId);
    if (!order || order.state !== 'cancel-in-flight' ||
        typeof priorState !== 'string' || TERMINAL_STATES.has(priorState) ||
        priorState === 'cancel-in-flight') return false;
    order.state = priorState;
    // Keep the sequence monotonic: an in-flight REST generation must still
    // observe that this reservation changed while its request was pending.
    order.lastMutationSequence = this._nextEvent();
    return true;
  }

  cancelRejected(orderId) {
    const order = this.reservations.get(orderId);
    if (!order || order.state !== 'cancel-in-flight') return false;
    order.state = 'active';
    order.acknowledgedLive = true;
    order.lastMutationSequence = this._nextEvent();
    return true;
  }

  cancelled(orderId) {
    return this._terminal(orderId, 'cancelled');
  }

  rejected(orderId) {
    return this._terminal(orderId, 'rejected');
  }

  expired(orderId) {
    return this._terminal(orderId, 'expired');
  }

  /**
   * REST absence does not prove cancellation: a delayed/lost fill may have
   * consumed the order. Remove venue-live presence while retaining the full
   * remaining commitment as a conservative delta until a newer coherent
   * balance/live-order snapshot absorbs it.
   */
  restOrderAbsent(orderId) {
    return this._unknownTerminal(
      orderId,
      'rest-absence-evidence-gap',
      'rest-order-absence-unknown-outcome',
    );
  }

  cancelRejectUnknown(orderId) {
    return this._unknownTerminal(
      orderId,
      'cancel-unknown-evidence-gap',
      'cancel-reject-unknown-order-outcome',
    );
  }

  _unknownTerminal(orderId, terminalState, reason) {
    const order = this.reservations.get(orderId);
    if (!order || TERMINAL_STATES.has(order.state)) return false;
    const remainingCommitment = reservationAmount(order);
    const asset = order.side === 'sell' ? 'base' : 'quote';
    const sequence = this._nextEvent();
    this.consumedEvents.push({ sequence, orderId, asset, amount: remainingCommitment });
    this.blockedSides.set(order.side, sequence);
    order.remainingSize = 0;
    order.state = terminalState;
    order.acknowledgedLive = false;
    order.representedByHeld = false;
    order.lastMutationSequence = sequence;
    this.state = 'degraded';
    this.reason = reason;
    this._recordTerminal(order);
    return {
      orderId,
      side: order.side,
      outcome: 'unknown',
      reason: this.reason,
      remainingCommitment,
    };
  }

  fill({ orderId, executionId, quantity, leavesQuantity }) {
    const order = this.reservations.get(orderId);
    if (!order || TERMINAL_STATES.has(order.state)) return false;
    if (!executionId) return this._evidenceGap(order, 'execution-id-required');
    if (this._hasProcessedExecution(orderId, executionId)) return false;
    const fillQuantity = finiteNonNegative(quantity, 'quantity');
    const leaves = finiteNonNegative(leavesQuantity, 'leavesQuantity');
    const expectedLeaves = Math.max(0, order.remainingSize - fillQuantity);
    if (fillQuantity <= 0 || fillQuantity > order.remainingSize + EPSILON ||
        Math.abs(leaves - expectedLeaves) > EPSILON) {
      return this._evidenceGap(order, 'inconsistent-fill-quantity');
    }
    this._recordProcessedExecution(orderId, executionId);

    if (!order.representedByHeld) {
      const asset = order.side === 'sell' ? 'base' : 'quote';
      this.consumedEvents.push({
        sequence: this._nextEvent(), orderId, asset,
        amount: order.side === 'sell' ? fillQuantity : fillQuantity * order.price,
      });
    } else {
      this._nextEvent();
    }
    order.lastMutationSequence = this.eventSequence;
    order.remainingSize = leaves;
    if (leaves <= EPSILON) {
      order.state = 'filled';
      order.acknowledgedLive = false;
      order.representedByHeld = false;
      this._recordTerminal(order);
    } else {
      order.acknowledgedLive = true;
      if (order.state !== 'cancel-in-flight') order.state = 'active';
    }
    return true;
  }

  fullFill(orderId, executionId, { lastQuantity = null, leavesQuantity = 0 } = {}) {
    const order = this.reservations.get(orderId);
    if (!order || TERMINAL_STATES.has(order.state)) return false;
    if (!executionId) return this._evidenceGap(order, 'execution-id-required');
    if (this._hasProcessedExecution(orderId, executionId)) return false;
    if (Number(leavesQuantity) !== 0) return this._evidenceGap(order, 'terminal-leaves-nonzero');
    const parsedLast = lastQuantity === null || lastQuantity === undefined ? null : Number(lastQuantity);
    const evidenceGap = parsedLast !== null &&
      (!Number.isFinite(parsedLast) || parsedLast <= 0 || Math.abs(parsedLast - order.remainingSize) > EPSILON);
    this._recordProcessedExecution(orderId, executionId);
    if (!order.representedByHeld) {
      const asset = order.side === 'sell' ? 'base' : 'quote';
      this.consumedEvents.push({
        sequence: this._nextEvent(), orderId, asset, amount: reservationAmount(order),
      });
    } else {
      this._nextEvent();
    }
    order.remainingSize = 0;
    order.state = 'filled';
    order.acknowledgedLive = false;
    order.representedByHeld = false;
    order.lastMutationSequence = this.eventSequence;
    this._recordTerminal(order);
    if (evidenceGap) this._evidenceGap(order, 'terminal-fill-quantity-gap', { block: true });
    return true;
  }

  insufficientFunds(side) {
    if (!SIDES.has(side)) throw new Error('side must be buy or sell');
    this.blockedSides.set(side, this._nextEvent());
    this.state = 'degraded';
    this.reason = `insufficient-funds-${side}-resync-required`;
  }

  reconciliationFailed() {
    this.state = 'failed';
    this.reason = 'balance-live-order-reconciliation-failed';
  }

  getAvailable(side) {
    if (!SIDES.has(side)) return 0;
    if (!this.initialized) return 0;
    const asset = side === 'sell' ? 'base' : 'quote';
    let unreflected = 0;
    for (const order of this.reservations.values()) {
      if (!TERMINAL_STATES.has(order.state) && !order.representedByHeld && order.side === side) {
        unreflected += reservationAmount(order);
      }
    }
    const consumed = this.consumedEvents
      .filter((event) => event.asset === asset)
      .reduce((sum, event) => sum + event.amount, 0);
    return Math.max(0, this.balances[asset].available - unreflected - consumed);
  }

  getQuoteCapacity(side) {
    if (this.blockedSides.has(side)) return 0;
    let reserved = 0;
    for (const order of this.reservations.values()) {
      if (!TERMINAL_STATES.has(order.state) && order.side === side) reserved += reservationAmount(order);
    }
    return this.getAvailable(side) + reserved;
  }

  getQuoteCapacityForLevel(side, level, plannedCommitment = 0) {
    const capacity = this.getQuoteCapacity(side);
    if (Number(level) <= 1) return capacity;
    const hasL1Reservation = [...this.reservations.values()].some((order) =>
      order.side === side && order.level === 1 && !TERMINAL_STATES.has(order.state)
    );
    if (hasL1Reservation) return capacity;
    const asset = side === 'sell' ? 'base' : 'quote';
    const planned = Number.isFinite(Number(plannedCommitment))
      ? Math.max(0, Number(plannedCommitment))
      : 0;
    return Math.max(0, capacity - Math.max(0, this.l1Reserve[asset] - planned));
  }

  getAvailableForLevel(side, level) {
    const available = this.getAvailable(side);
    if (Number(level) <= 1) return available;
    const hasL1Reservation = [...this.reservations.values()].some((order) =>
      order.side === side && order.level === 1 && !TERMINAL_STATES.has(order.state)
    );
    if (hasL1Reservation) return available;
    const asset = side === 'sell' ? 'base' : 'quote';
    return Math.max(0, available - this.l1Reserve[asset]);
  }

  getReservation(orderId) {
    const order = this.reservations.get(orderId);
    return order ? { ...order } : null;
  }

  isActionableReservation(orderId) {
    const order = this.reservations.get(orderId);
    return Boolean(order && !TERMINAL_STATES.has(order.state));
  }

  getReservations() {
    return [...this.reservations.values()].map((order) => ({ ...order }));
  }

  getPresence() {
    const presence = { buy: 0, sell: 0 };
    const levels = { buy: new Set(), sell: new Set() };
    for (const order of this.reservations.values()) {
      if (order.acknowledgedLive && !TERMINAL_STATES.has(order.state) &&
          Number.isInteger(order.level) && order.level > 0 && order.remainingSize >= this.minimumFundedQuoteSize) {
        levels[order.side].add(order.level);
      }
    }
    presence.buy = levels.buy.size;
    presence.sell = levels.sell.size;
    return presence;
  }

  getStatus() {
    return {
      state: this.state,
      reason: this.reason,
      balances: { base: { ...this.balances.base }, quote: { ...this.balances.quote } },
      available: { buy: this.getAvailable('buy'), sell: this.getAvailable('sell') },
      blockedSides: [...this.blockedSides.keys()].sort(),
      presence: this.getPresence(),
    };
  }

  _terminal(orderId, state) {
    const order = this.reservations.get(orderId);
    if (!order || TERMINAL_STATES.has(order.state)) return false;
    order.state = state;
    order.remainingSize = 0;
    order.acknowledgedLive = false;
    order.representedByHeld = false;
    order.lastMutationSequence = this._nextEvent();
    this._recordTerminal(order);
    return true;
  }

  takeEvidenceGap() {
    const gap = this.pendingEvidenceGap;
    this.pendingEvidenceGap = null;
    return gap;
  }

  failClosedForEvidenceGap(orderId, reason) {
    const order = this.reservations.get(orderId);
    if (!order || TERMINAL_STATES.has(order.state)) return false;
    if (order.evidenceGapReason === reason) return false;
    order.evidenceGapReason = reason;
    order.lastMutationSequence = this.eventSequence + 1;
    this._evidenceGap(order, reason);
    return true;
  }

  terminalEvidenceGap(orderId, reason) {
    const order = this.reservations.get(orderId);
    if (!order || TERMINAL_STATES.has(order.state)) return false;
    if (!order.representedByHeld) {
      const asset = order.side === 'sell' ? 'base' : 'quote';
      this.consumedEvents.push({
        sequence: this._nextEvent(), orderId, asset, amount: reservationAmount(order),
      });
    } else {
      this._nextEvent();
    }
    order.remainingSize = 0;
    order.state = 'terminal-evidence-gap';
    order.acknowledgedLive = false;
    order.representedByHeld = false;
    order.lastMutationSequence = this.eventSequence;
    this._recordTerminal(order);
    this._evidenceGap(order, reason, { block: true });
    return true;
  }

  _nextEvent() {
    return ++this.eventSequence;
  }

  _evidenceGap(order, reason, { block = true } = {}) {
    const sequence = this._nextEvent();
    if (block) this.blockedSides.set(order.side, sequence);
    this.state = 'degraded';
    this.reason = reason;
    this.pendingEvidenceGap = { side: order.side, reason };
    return false;
  }

  _hasProcessedExecution(orderId, executionId) {
    return this.processedExecutions.get(orderId)?.has(executionId) || false;
  }

  _recordProcessedExecution(orderId, executionId) {
    let ids = this.processedExecutions.get(orderId);
    if (!ids) {
      ids = new Set();
      this.processedExecutions.set(orderId, ids);
    }
    ids.add(executionId);
  }

  _recordTerminal(order) {
    if (!TERMINAL_STATES.has(order.state) || order.terminalSequence) return;
    order.terminalSequence = this.eventSequence || this._nextEvent();
    this.terminalReservations.push({ orderId: order.orderId, terminalSequence: order.terminalSequence });
    while (this.terminalReservations.length > this.maxTerminalReservations) {
      const oldest = this.terminalReservations.shift();
      const candidate = this.reservations.get(oldest.orderId);
      if (candidate?.terminalSequence === oldest.terminalSequence && TERMINAL_STATES.has(candidate.state)) {
        this.reservations.delete(oldest.orderId);
        this.processedExecutions.delete(oldest.orderId);
      }
    }
  }
}
