#!/usr/bin/env bun
/**
 * Trace specific order lifecycle through audit log
 */
const today = new Date().toISOString().slice(0, 10);
const path = `logs/truex-audit/truex-audit-${today}.jsonl`;
const text = await Bun.file(path).text();
const lines = text.split('\n').filter(Boolean);

// Track all events for each unique clOrdID
const orderEvents = new Map();
const cancelMap = new Map(); // cancel clOrdID → orig clOrdID

for (const line of lines) {
  try {
    const entry = JSON.parse(line);
    const f = entry?.rawMessage?.fields;
    if (!f) continue;
    const msgType = f['35'];
    if (msgType === '0' || msgType === 'A') continue;

    const clOrdID = f['11'];
    const origClOrdID = f['41'];
    const ordStatus = f['39'];
    const dir = entry?.direction || (msgType === 'D' || msgType === 'F' || msgType === 'G' ? 'OUT' : 'IN');

    const event = {
      dir,
      msgType,
      ordStatus,
      text: f['58'] || '',
      side: f['54'],
      price: f['44'],
      qty: f['38'],
      cxlRejReason: f['102'],
    };

    if (!orderEvents.has(clOrdID)) orderEvents.set(clOrdID, []);
    orderEvents.get(clOrdID).push(event);

    if (origClOrdID) {
      cancelMap.set(clOrdID, origClOrdID);
      if (!orderEvents.has(origClOrdID)) orderEvents.set(origClOrdID, []);
      orderEvents.get(origClOrdID).push({ ...event, asCancel: clOrdID });
    }
  } catch {}
}

// Find the "Unknown order" cancel rejects and their target orders
const unknownOrders = new Set();
for (const [clOrdID, events] of orderEvents) {
  for (const e of events) {
    if (e.msgType === '9' && e.text === 'Unknown order' && e.asCancel) {
      unknownOrders.add(clOrdID);
    }
  }
}

console.log(`Found ${unknownOrders.size} orders with "Unknown order" cancel rejects\n`);

// Show lifecycle for first 5 affected orders
let count = 0;
for (const clOrdID of unknownOrders) {
  if (count++ >= 5) break;
  console.log(`=== ${clOrdID} ===`);
  const events = orderEvents.get(clOrdID);
  for (const e of events) {
    if (e.asCancel) {
      console.log(`  [CANCEL by ${e.asCancel}] msgType=${e.msgType} ordStatus=${e.ordStatus} ${e.text} cxlRej=${e.cxlRejReason || ''}`);
    } else {
      const label = e.msgType === '8' ? `ExecReport(${e.ordStatus})` :
                    e.msgType === '9' ? `CancelReject` :
                    e.msgType === 'D' ? `NewOrder` :
                    e.msgType === 'F' ? `CancelReq` : `msg=${e.msgType}`;
      console.log(`  ${label} ${e.text} ${e.side ? `side=${e.side}` : ''} ${e.price ? `price=${e.price}` : ''} ${e.qty ? `qty=${e.qty}` : ''}`);
    }
  }
  console.log();
}
