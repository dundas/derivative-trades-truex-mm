import 'reflect-metadata';
import { BaseExchangeAdapter } from './BaseExchangeAdapter.js';
import jspurefix from 'jspurefix';
const { 
  initiator,
  AsciiSession,
  MsgTransport,
  FixAcceptor,
  IJsFixConfig,
  SessionMsgFactory,
  MsgView,
  MsgType,
  EncryptMethod,
  ResetSeqNumFlag
} = jspurefix;
// FIX constants
const Side = { Buy: '1', Sell: '2' };
const OrdType = { Market: '1', Limit: '2' };
const TimeInForce = { GoodTillCancel: '1', ImmediateOrCancel: '3' };
const ExecType = { New: '0', PartialFill: '1', Fill: '2', Canceled: '4', Rejected: '8' };
const OrdStatus = { 
  New: '0', 
  PartiallyFilled: '1', 
  Filled: '2', 
  Canceled: '4', 
  PendingCancel: '6',
  Rejected: '8',
  Suspended: '9',
  PendingNew: 'A',
  Expired: 'C'
};
const SubscriptionRequestType = { 
  Snapshot: '0', 
  SnapshotPlusUpdates: '1', 
  UnsubscribeRequest: '2' 
};
const MDEntryType = { Bid: '0', Offer: '1', Trade: '2' };
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * TrueX FIX Exchange Adapter V2
 * 
 * Uses jspurefix library for proper FIX 5.0 SP2 protocol implementation
 * Manages separate sessions for Order Entry and Market Data
 */
export class TrueXFIXExchangeAdapter extends BaseExchangeAdapter {
  constructor(config) {
    super({
      ...config,
      exchangeName: 'TrueX',
      strategyName: config.strategyName || 'truex_fix_strategy'
    });

    // Connection configuration
    this.orderEntryHost = config.orderEntryHost || 'fix-order.truex.co';
    this.orderEntryPort = config.orderEntryPort || 443;
    this.marketDataHost = config.marketDataHost || 'fix-market.truex.co';
    this.marketDataPort = config.marketDataPort || 443;
    
    // Authentication
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.senderCompID = config.senderCompID || 'CLIENT';
    this.targetCompID = config.targetCompID || 'TRUEX';
    
    // Session management
    this.orderSession = null;
    this.marketDataSession = null;
    this.orderInitiator = null;
    this.marketDataInitiator = null;
    
    // Connection state
    this.isOrderConnected = false;
    this.isMarketDataConnected = false;
    
    // Heartbeat settings
    this.heartbeatInterval = config.heartbeatInterval || 30;
    
    // Order tracking
    this.pendingOrders = new Map();
    this.orderIdToClOrdId = new Map();
    
    // Market data
    this.marketDataSubscriptions = new Map();
    this.marketDataRequestId = 1;
    
    // Reconnection settings
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 5;
    this.reconnectDelay = config.initialReconnectDelayMs || 1000;
    this.maxReconnectDelay = config.maxReconnectDelayMs || 30000;
    
    // Dictionary path - you'll need to provide the FIX 5.0 SP2 dictionary
    this.dictionaryPath = config.dictionaryPath || path.join(__dirname, 'fix-dictionaries/FIX50SP2.xml');
  }

  /**
   * Creates FIX session configuration
   */
  _createSessionConfig(sessionType) {
    const isOrderEntry = sessionType === 'order';
    
    return {
      application: {
        reconnectSeconds: this.reconnectDelay / 1000,
        type: 'initiator',
        name: `truex_${sessionType}_client`,
        tcp: {
          host: isOrderEntry ? this.orderEntryHost : this.marketDataHost,
          port: isOrderEntry ? this.orderEntryPort : this.marketDataPort,
          tls: {
            timeout: 30000,
            enableTrace: false,
            rejectUnauthorized: true
          }
        },
        protocol: 'ascii',
        dictionary: this.dictionaryPath
      },
      Username: this.apiKey,
      Password: '', // Will be set dynamically in logon
      EncryptMethod: 0,
      ResetSeqNumFlag: true,
      HeartBtInt: this.heartbeatInterval,
      SenderCompId: this.senderCompID,
      TargetCompID: this.targetCompID,
      BeginString: 'FIXT.1.1',
      DefaultApplVerID: 'FIX.5.0SP2',
      SessionQualifier: sessionType.toUpperCase(),
      logoutAfterError: true
    };
  }

  /**
   * Connects to both Order Entry and Market Data sessions
   */
  async connect() {
    this.logger.info(`[TrueX FIX] Connecting to TrueX FIX API...`);
    
    try {
      // Connect to Order Entry session
      await this._connectOrderEntry();
      
      // Connect to Market Data session
      await this._connectMarketData();
      
      this.logger.info(`[TrueX FIX] Successfully connected to all sessions`);
    } catch (error) {
      this.logger.error(`[TrueX FIX] Connection failed: ${error.message}`, { error });
      throw error;
    }
  }

  /**
   * Connects to the Order Entry session
   */
  async _connectOrderEntry() {
    return new Promise(async (resolve, reject) => {
      try {
        this.logger.info(`[TrueX FIX] Connecting to Order Entry...`);
        
        const config = this._createSessionConfig('order');
        
        // Create initiator
        this.orderInitiator = await initiator(config);
        
        // Set up session event handlers
        this.orderInitiator.on('session', (session) => {
          this.logger.info(`[TrueX FIX] Order Entry session created`);
          this.orderSession = new TrueXOrderSession(this, session);
          
          // Override onLogon to generate signature
          const originalOnLogon = session.onLogon.bind(session);
          session.onLogon = (view) => {
            // Generate HMAC signature
            const msgSeqNum = view.getTyped('MsgSeqNum');
            const sendingTime = view.getTyped('SendingTime');
            const msgType = 'A'; // Logon
            
            const message = sendingTime + msgType + msgSeqNum + 
                          this.senderCompID + this.targetCompID + this.apiKey;
            const signature = crypto.createHmac('sha256', this.apiSecret)
              .update(message)
              .digest('base64');
            
            // Set password in the logon message
            view.setString('Password', signature);
            
            // Add session configuration
            view.setString('Text', 'CancelOnDisconnect=Y');
            
            // Call original onLogon
            return originalOnLogon(view);
          };
          
          session.on('logon', () => {
            this.logger.info(`[TrueX FIX] Order Entry logged on`);
            this.isOrderConnected = true;
            resolve();
          });
          
          session.on('logout', () => {
            this.logger.info(`[TrueX FIX] Order Entry logged out`);
            this.isOrderConnected = false;
          });
          
          session.on('error', (error) => {
            this.logger.error(`[TrueX FIX] Order Entry session error: ${error.message}`);
            reject(error);
          });
        });
        
        // Start the initiator
        await this.orderInitiator.start();
        
      } catch (error) {
        this.logger.error(`[TrueX FIX] Order Entry connection error: ${error.message}`);
        reject(error);
      }
    });
  }

  /**
   * Connects to the Market Data session
   */
  async _connectMarketData() {
    return new Promise(async (resolve, reject) => {
      try {
        this.logger.info(`[TrueX FIX] Connecting to Market Data...`);
        
        const config = this._createSessionConfig('marketData');
        
        // Create initiator
        this.marketDataInitiator = await initiator(config);
        
        // Set up session event handlers
        this.marketDataInitiator.on('session', (session) => {
          this.logger.info(`[TrueX FIX] Market Data session created`);
          this.marketDataSession = new TrueXMarketDataSession(this, session);
          
          // Override onLogon to generate signature
          const originalOnLogon = session.onLogon.bind(session);
          session.onLogon = (view) => {
            // Generate HMAC signature
            const msgSeqNum = view.getTyped('MsgSeqNum');
            const sendingTime = view.getTyped('SendingTime');
            const msgType = 'A'; // Logon
            
            const message = sendingTime + msgType + msgSeqNum + 
                          this.senderCompID + this.targetCompID + this.apiKey;
            const signature = crypto.createHmac('sha256', this.apiSecret)
              .update(message)
              .digest('base64');
            
            // Set password in the logon message
            view.setString('Password', signature);
            
            // Call original onLogon
            return originalOnLogon(view);
          };
          
          session.on('logon', () => {
            this.logger.info(`[TrueX FIX] Market Data logged on`);
            this.isMarketDataConnected = true;
            resolve();
          });
          
          session.on('logout', () => {
            this.logger.info(`[TrueX FIX] Market Data logged out`);
            this.isMarketDataConnected = false;
          });
          
          session.on('error', (error) => {
            this.logger.error(`[TrueX FIX] Market Data session error: ${error.message}`);
            reject(error);
          });
        });
        
        // Start the initiator
        await this.marketDataInitiator.start();
        
      } catch (error) {
        this.logger.error(`[TrueX FIX] Market Data connection error: ${error.message}`);
        reject(error);
      }
    });
  }

  /**
   * Creates a new order
   */
  async createOrder(orderParams) {
    if (!this.isOrderConnected || !this.orderSession) {
      throw new Error('Order Entry session not connected');
    }
    
    const {
      symbol = this.tradingPair,
      type = 'limit',
      side,
      price,
      amount,
      clientId,
      params = {}
    } = orderParams;
    
    // Generate client order ID
    const clOrdId = clientId || `${this.sessionId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Validate required fields
    if (!side || !amount) {
      throw new Error('Missing required order parameters: side and amount are required');
    }
    
    if (type === 'limit' && !price) {
      throw new Error('Price is required for limit orders');
    }
    
    // Store pending order
    this.pendingOrders.set(clOrdId, {
      ...orderParams,
      clientOrderId: clOrdId,
      status: 'pending'
    });
    
    // Create new order single message
    const order = this.orderSession.factory.create(MsgType.NewOrderSingle);
    
    // Set order fields
    order.ClOrdID = clOrdId;
    order.Symbol = symbol;
    order.Side = side === 'buy' ? Side.Buy : Side.Sell;
    order.OrderQty = amount;
    order.OrdType = type === 'market' ? OrdType.Market : OrdType.Limit;
    order.TimeInForce = params.timeInForce === 'IOC' ? TimeInForce.ImmediateOrCancel : TimeInForce.GoodTillCancel;
    
    if (type === 'limit') {
      order.Price = price;
    }
    
    // Add execution instructions if provided
    if (params.execInst === 'ALO') {
      order.ExecInst = '6'; // Add Liquidity Only
    }
    
    // Add self-match prevention if provided
    // Tag 2362: SelfMatchPreventionID - identifier for matching prevention
    // Tag 2964: SelfMatchPreventionInstruction - instruction type
    if (params.selfMatchPreventionId) {
      // Add as custom field (jspurefix may not have these defined)
      order.setField(2362, params.selfMatchPreventionId);
    }
    
    if (params.selfMatchPreventionInstruction !== undefined) {
      // Common values: 0=Cancel Resting, 1=Cancel Aggressing, 2=Decrement and Cancel
      order.setField(2964, params.selfMatchPreventionInstruction);
    }
    
    // Add parties
    order.NoPartyIDs = 1;
    order.PartyID = params.partyId || 'CLIENT';
    order.PartyRole = 3; // Client ID
    
    // Send order
    await this.orderSession.send(order);
    
    this.logger.info(`[TrueX FIX] Sent new order: ${clOrdId}`, {
      symbol,
      side,
      type,
      price,
      amount
    });
    
    // Return provisional order object
    return {
      id: clOrdId,
      clientOrderId: clOrdId,
      symbol,
      side,
      type,
      price,
      amount,
      status: 'pending',
      timestamp: Date.now(),
      filled: 0,
      remaining: amount
    };
  }

  /**
   * Cancels an order
   */
  async cancelOrder(orderId, params = {}) {
    if (!this.isOrderConnected || !this.orderSession) {
      throw new Error('Order Entry session not connected');
    }
    
    // Get client order ID
    const clOrdId = this.orderIdToClOrdId.get(orderId) || orderId;
    const order = this.activeOrders.get(orderId);
    
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }
    
    // Generate new client order ID for cancel request
    const cancelClOrdId = `${clOrdId}-cancel-${Date.now()}`;
    
    // Create cancel request
    const cancelReq = this.orderSession.factory.create(MsgType.OrderCancelRequest);
    
    cancelReq.ClOrdID = cancelClOrdId;
    cancelReq.OrigClOrdID = clOrdId;
    cancelReq.OrderID = orderId;
    cancelReq.Symbol = order.symbol;
    cancelReq.Side = order.side === 'buy' ? Side.Buy : Side.Sell;
    
    // Add parties
    cancelReq.NoPartyIDs = 1;
    cancelReq.PartyID = params.partyId || 'CLIENT';
    cancelReq.PartyRole = 3; // Client ID
    
    // Send cancel request
    await this.orderSession.send(cancelReq);
    
    this.logger.info(`[TrueX FIX] Sent cancel request for order: ${orderId}`);
    
    // Update order status to pending cancel
    await this._updateOrderStatus(orderId, 'pending-cancel');
    
    return { id: orderId, status: 'pending-cancel' };
  }

  /**
   * Subscribes to market data
   */
  async subscribeMarketData(symbol, types = ['orderbook', 'trades']) {
    if (!this.isMarketDataConnected || !this.marketDataSession) {
      throw new Error('Market Data session not connected');
    }
    
    const mdReqId = `MDR-${this.marketDataRequestId++}`;
    
    // Create market data request
    const mdReq = this.marketDataSession.factory.create(MsgType.MarketDataRequest);
    
    mdReq.MDReqID = mdReqId;
    mdReq.SubscriptionRequestType = SubscriptionRequestType.SnapshotPlusUpdates;
    mdReq.MarketDepth = 10;
    
    // Add symbols
    mdReq.NoRelatedSym = 1;
    mdReq.Symbol = symbol;
    mdReq.SecurityType = 'CSPOT';
    
    // Add entry types
    const entryTypes = [];
    if (types.includes('orderbook')) {
      entryTypes.push(MDEntryType.Bid, MDEntryType.Offer);
    }
    if (types.includes('trades')) {
      entryTypes.push(MDEntryType.Trade);
    }
    
    mdReq.NoMDEntryTypes = entryTypes.length;
    // Note: You'll need to add MDEntryTypes as a repeating group
    
    // Store subscription
    this.marketDataSubscriptions.set(mdReqId, {
      symbol,
      types,
      timestamp: Date.now()
    });
    
    // Send request
    await this.marketDataSession.send(mdReq);
    
    this.logger.info(`[TrueX FIX] Subscribed to market data for ${symbol}`);
  }

  /**
   * Fetches current balances
   */
  async fetchBalances() {
    // TrueX FIX protocol doesn't provide balance information directly
    this.logger.warn(`[TrueX FIX] Balance fetching not supported via FIX protocol`);
    this.currentBalances = {};
    return this.currentBalances;
  }

  /**
   * Fetches open positions
   */
  async fetchPositions() {
    return {};
  }

  /**
   * Cancels all managed orders
   */
  async cancelAllManagedOrders(reason) {
    const results = [];
    
    for (const [orderId, order] of this.activeOrders) {
      if (order.status === 'open' || order.status === 'partially-filled') {
        try {
          await this.cancelOrder(orderId);
          results.push({ orderId, success: true });
        } catch (error) {
          results.push({ orderId, success: false, error: error.message });
        }
      }
    }
    
    return results;
  }

  /**
   * Cancels all open buy orders
   */
  async cancelOpenBuyOrders(reason) {
    const results = [];
    
    for (const [orderId, order] of this.activeOrders) {
      if (order.side === 'buy' && (order.status === 'open' || order.status === 'partially-filled')) {
        try {
          await this.cancelOrder(orderId);
          results.push({ orderId, success: true });
        } catch (error) {
          results.push({ orderId, success: false, error: error.message });
        }
      }
    }
    
    return results;
  }

  /**
   * Gets order status
   */
  async getOrderStatus(orderId) {
    const order = this.activeOrders.get(orderId);
    
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }
    
    return order;
  }

  /**
   * Gets list of tradable pairs
   */
  async getTradablePairs() {
    // This would typically be fetched via SecurityListRequest
    return ['BTC/USD', 'ETH/USD', 'BTC/USDC', 'ETH/USDC'];
  }

  /**
   * Gets pair details
   */
  async getPairDetails(pair) {
    return {
      symbol: pair,
      base: pair.split('/')[0],
      quote: pair.split('/')[1],
      minOrderSize: 0.001,
      minPriceIncrement: 0.01,
      precision: {
        amount: 8,
        price: 2
      }
    };
  }

  /**
   * Disconnects from TrueX
   */
  async disconnect() {
    this.logger.info(`[TrueX FIX] Disconnecting from TrueX...`);
    
    // Stop initiators
    if (this.orderInitiator) {
      await this.orderInitiator.stop();
      this.orderInitiator = null;
    }
    
    if (this.marketDataInitiator) {
      await this.marketDataInitiator.stop();
      this.marketDataInitiator = null;
    }
    
    this.isOrderConnected = false;
    this.isMarketDataConnected = false;
    
    this.logger.info(`[TrueX FIX] Disconnected successfully`);
  }
}

/**
 * Order Entry Session Handler
 */
class TrueXOrderSession extends AsciiSession {
  constructor(adapter, session) {
    super(session.config, session.sessionState, session.transport, session.logger);
    this.adapter = adapter;
    this.factory = new SessionMsgFactory(session.config);
  }
  
  onApplicationMsg(msgType, view) {
    this.adapter.logger.debug(`[TrueX Order] Received ${msgType}`);
    
    switch (msgType) {
      case MsgType.ExecutionReport:
        this.handleExecutionReport(view);
        break;
      case MsgType.OrderCancelReject:
        this.handleOrderCancelReject(view);
        break;
      case MsgType.BusinessMessageReject:
        this.handleBusinessReject(view);
        break;
    }
  }
  
  handleExecutionReport(view) {
    const report = view.toObject();
    
    const clOrdId = report.ClOrdID;
    const orderId = report.OrderID;
    const orderStatus = report.OrdStatus;
    const execType = report.ExecType;
    
    // Map exchange order ID to client order ID
    if (orderId && clOrdId) {
      this.adapter.orderIdToClOrdId.set(orderId, clOrdId);
    }
    
    // Get pending order
    const pendingOrder = this.adapter.pendingOrders.get(clOrdId);
    
    // Create order object
    const order = {
      id: orderId,
      clientOrderId: clOrdId,
      symbol: report.Symbol,
      side: report.Side === Side.Buy ? 'buy' : 'sell',
      type: pendingOrder?.type || 'limit',
      price: report.Price,
      amount: report.OrderQty,
      filled: report.CumQty || 0,
      remaining: report.LeavesQty || (report.OrderQty - (report.CumQty || 0)),
      status: this.mapOrderStatus(orderStatus),
      timestamp: Date.now(),
      avgFillPrice: report.AvgPx,
      text: report.Text
    };
    
    // Handle different execution types
    switch (execType) {
      case ExecType.New:
        this.adapter.logger.info(`[TrueX FIX] Order accepted: ${clOrdId}`, order);
        this.adapter._storeOrder(order);
        break;
        
      case ExecType.Trade:
        this.adapter.logger.info(`[TrueX FIX] Order filled: ${clOrdId}`);
        
        // Process the fill
        if (report.LastPx && report.LastQty) {
          const fillData = {
            orderId,
            fillId: report.ExecID,
            price: report.LastPx,
            amount: report.LastQty,
            side: report.Side === Side.Buy ? 'buy' : 'sell',
            timestamp: Date.now(),
            fee: 0,
            // Tag 851: LastLiquidityInd - 1=Added Liquidity (maker), 2=Removed Liquidity (taker)
            liquidityIndicator: report.LastLiquidityInd === 1 ? 'maker' : report.LastLiquidityInd === 2 ? 'taker' : null
          };
          
          this.adapter._processFill(fillData);
        }
        
        // Update order status
        this.adapter._updateOrderStatus(orderId, order.status, {
          filled: report.CumQty,
          remaining: report.LeavesQty,
          avgFillPrice: report.AvgPx
        });
        break;
        
      case ExecType.Canceled:
        this.adapter.logger.info(`[TrueX FIX] Order canceled: ${clOrdId}`);
        this.adapter._updateOrderStatus(orderId, 'canceled');
        this.adapter.pendingOrders.delete(clOrdId);
        break;
        
      case ExecType.Rejected:
        this.adapter.logger.error(`[TrueX FIX] Order rejected: ${clOrdId}, reason: ${report.Text}`);
        this.adapter._updateOrderStatus(orderId, 'rejected');
        this.adapter.pendingOrders.delete(clOrdId);
        this.adapter._emitError('ORDER_REJECTED', report.Text, { clOrdId, orderId });
        break;
    }
  }
  
  handleOrderCancelReject(view) {
    const reject = view.toObject();
    
    const clOrdId = reject.ClOrdID;
    const origClOrdId = reject.OrigClOrdID;
    const orderId = reject.OrderID;
    const text = reject.Text;
    
    this.adapter.logger.error(`[TrueX FIX] Order cancel rejected: ${orderId}`, { text });
    
    // Revert status from pending-cancel
    const order = this.adapter.activeOrders.get(orderId);
    if (order && order.status === 'pending-cancel') {
      this.adapter._updateOrderStatus(orderId, 'open');
    }
    
    this.adapter._emitError('CANCEL_REJECTED', text, { orderId });
  }
  
  handleBusinessReject(view) {
    const reject = view.toObject();
    this.adapter.logger.error(`[TrueX FIX] Business reject`, reject);
    this.adapter._emitError('BUSINESS_REJECT', reject.Text, reject);
  }
  
  mapOrderStatus(fixStatus) {
    const statusMap = {
      [OrdStatus.New]: 'open',
      [OrdStatus.PartiallyFilled]: 'partially-filled',
      [OrdStatus.Filled]: 'closed',
      [OrdStatus.Canceled]: 'canceled',
      [OrdStatus.PendingCancel]: 'pending-cancel',
      [OrdStatus.Rejected]: 'rejected',
      [OrdStatus.Suspended]: 'suspended',
      [OrdStatus.PendingNew]: 'pending',
      [OrdStatus.Expired]: 'expired'
    };
    
    return statusMap[fixStatus] || 'unknown';
  }
}

/**
 * Market Data Session Handler
 */
class TrueXMarketDataSession extends AsciiSession {
  constructor(adapter, session) {
    super(session.config, session.sessionState, session.transport, session.logger);
    this.adapter = adapter;
    this.factory = new SessionMsgFactory(session.config);
  }
  
  onApplicationMsg(msgType, view) {
    this.adapter.logger.debug(`[TrueX Market Data] Received ${msgType}`);
    
    switch (msgType) {
      case MsgType.MarketDataSnapshotFullRefresh:
        this.handleMarketDataSnapshot(view);
        break;
      case MsgType.MarketDataIncrementalRefresh:
        this.handleMarketDataIncremental(view);
        break;
      case MsgType.MarketDataRequestReject:
        this.handleMarketDataRequestReject(view);
        break;
      case MsgType.SecurityList:
        this.handleSecurityList(view);
        break;
    }
  }
  
  handleMarketDataSnapshot(view) {
    const snapshot = view.toObject();
    
    const orderBook = {
      symbol: snapshot.Symbol,
      bids: [],
      asks: [],
      timestamp: Date.now()
    };
    
    // Parse market data entries
    if (snapshot.NoMDEntries && snapshot.MDEntries) {
      for (const entry of snapshot.MDEntries) {
        const bookEntry = [entry.MDEntryPx, entry.MDEntrySize];
        
        if (entry.MDEntryType === MDEntryType.Bid) {
          orderBook.bids.push(bookEntry);
        } else if (entry.MDEntryType === MDEntryType.Offer) {
          orderBook.asks.push(bookEntry);
        }
      }
    }
    
    // Sort order book
    orderBook.bids.sort((a, b) => b[0] - a[0]);
    orderBook.asks.sort((a, b) => a[0] - b[0]);
    
    // Emit order book update
    this.adapter._emitOrderBookUpdate(orderBook);
  }
  
  handleMarketDataIncremental(view) {
    const update = view.toObject();
    this.adapter.logger.debug(`[TrueX FIX] Market data incremental update`, update);
    // Process incremental updates...
  }
  
  handleMarketDataRequestReject(view) {
    const reject = view.toObject();
    this.adapter.logger.error(`[TrueX FIX] Market data request rejected`, reject);
    this.adapter._emitError('MARKET_DATA_REJECT', reject.Text, reject);
  }
  
  handleSecurityList(view) {
    const list = view.toObject();
    this.adapter.logger.info(`[TrueX FIX] Security list received`, list);
    // Process security list...
  }
}

export default TrueXFIXExchangeAdapter;