import { decimal, positive, type InstrumentPolicy } from './execution';
const S = 10n ** 18n;
export const format = (n: bigint) => `${n < 0n ? '-' : ''}${(n < 0n ? -n : n) / S}.${((n < 0n ? -n : n) % S).toString().padStart(18,'0')}`.replace(/\.?0+$/, '');
export interface MakerLimits { capital: string; lossStop: string; orderNotional: string; halfSpreadBps: number; inventorySkewBps: number }
export function planQuotes(p: InstrumentPolicy, limits: MakerLimits, cash: string, inventory: string, bid: string, ask: string) {
  const capital = positive(limits.capital), loss = positive(limits.lossStop), maxOrder = positive(limits.orderNotional);
  const q = decimal(inventory), money = decimal(cash), b = positive(bid), a = positive(ask);
  if (q < 0n || money < 0n || b >= a || loss > capital || maxOrder > capital ||
      !Number.isInteger(limits.halfSpreadBps) || limits.halfSpreadBps < 1 ||
      !Number.isInteger(limits.inventorySkewBps) || limits.inventorySkewBps < 0) throw new Error('Invalid maker inputs');
  const equity = money + q * b / S, pnl = equity - capital;
  if (pnl <= -loss) return { pnl: format(pnl), stop: true, orders: [] };
  const maxPosition = positive(p.maxPositionQty), tick = positive(p.tickSize), lot = positive(p.lotSize);
  const mid = (b + a) / 2n;
  const skew = mid * BigInt(limits.inventorySkewBps) * (q > maxPosition ? maxPosition : q) / maxPosition / 10000n;
  // Reference spread is a pricing input, not a stop threshold. Preserve an outward margin.
  const margin = mid * BigInt(limits.halfSpreadBps) / 10000n;
  const rawBid = b - margin - skew;
  const rawAsk = a + margin - skew;
  const buy = rawBid / tick * tick;
  const sell = ((rawAsk > a ? rawAsk : a) + tick - 1n) / tick * tick;
  if (buy <= 0n || sell <= buy) throw new Error('Invalid computed prices');
  const min = (...ns: bigint[]) => ns.reduce((a,b)=>a<b?a:b);
  // Scale down as the reference widens, bounded below by a tradable lot/minimum notional.
  const baseline = margin * 2n;
  const scaled = maxOrder * baseline / (baseline + a - b);
  const minimumBudget = positive(p.minNotional) + (lot * sell + S - 1n) / S;
  const adaptiveBudget = min(maxOrder, scaled > minimumBudget ? scaled : minimumBudget);
  const remainingCapital = capital - q * buy / S;
  const buyBudget = min(money, remainingCapital, adaptiveBudget, positive(p.maxOrderNotional));
  const buyQty = min(buyBudget > 0n ? buyBudget * S / buy : 0n, maxPosition > q ? maxPosition - q : 0n) / lot * lot;
  const sellQty = min(q, min(adaptiveBudget, positive(p.maxOrderNotional)) * S / sell) / lot * lot;
  const orders: {side:'BUY'|'SELL';qty:string;price:string}[]=[];
  for (const [side, qty, price] of [['BUY',buyQty,buy],['SELL',sellQty,sell]] as const) {
    if (qty > 0n && qty * price / S >= positive(p.minNotional)) orders.push({side,qty:format(qty),price:format(price)});
  }
  return { pnl: format(pnl), stop: false, orders };
}

/** Ambiguous DELETE outcomes must still be followed by status reads. Never replay entries. */
export async function cancelAndConfirm(controller: {cancelOwned():Promise<unknown>;reconcile():Promise<unknown>},
  states:()=>{uncertain:boolean;latest?:{status:string}}[], attempts=10, pause=()=>new Promise<void>(r=>setTimeout(r,250))) {
  const terminal=(s:string)=>['FILLED','CANCELED','REJECTED'].includes(s);
  let needCancel=true;
  for(let i=0;i<attempts;i++) {
    if(needCancel) { try{await controller.cancelOwned();}catch{/* Status reads below resolve ambiguous cancellation. */} }
    try{await controller.reconcile();}catch{/* Preserve uncertainty and retry read; never resend an entry. */}
    const rows=states();
    if(rows.every(s=>!s.uncertain&&s.latest&&terminal(s.latest.status)))return;
    // A repeated cancellation is risk-reducing; never interpret a failed request as absence.
    needCancel=rows.some(s=>s.uncertain||s.latest?.status==='ACTIVE');
    await pause();
  }
  throw Error('Owned cancellation remains unresolved');
}
