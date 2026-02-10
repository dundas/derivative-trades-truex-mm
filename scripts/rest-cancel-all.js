#!/usr/bin/env bun
/**
 * Cancel all active orders on TrueX UAT via REST API
 */
import { TrueXRESTClient } from '../src/exchanges/truex/TrueXRESTClient.ts';

// Debug: try different userId values
const baseURL = (process.env.TRUEX_REST_URL || 'http://38.32.101.229:9742') + '/api/v1';
const apiKey = process.env.TRUEX_API_KEY;
const apiSecret = process.env.TRUEX_SECRET_KEY;
const clientId = process.env.TRUEX_CLIENT_ID || '78972918929686546';

console.log('REST URL:', baseURL);
console.log('API Key:', apiKey?.substring(0, 8) + '...');
console.log('Client ID:', clientId);

const client = new TrueXRESTClient({
  baseURL,
  apiKey,
  apiSecret,
  userId: clientId,
});

console.log('\nQuerying active orders...');
try {
  const active = await client.getActiveOrders();
  console.log(`Found ${active.length} active orders`);

  if (active.length > 0) {
    console.log('\nFirst 5 orders:');
    for (const order of active.slice(0, 5)) {
      const parsed = TrueXRESTClient.parseOrder(order);
      console.log(`  ${parsed.id} | ${parsed.side} ${parsed.qty} @ ${parsed.price} | status=${parsed.status} | ext=${parsed.externalId}`);
    }

    console.log('\nCancelling all...');
    const result = await client.cancelAllOrders();
    console.log(`Cancelled: ${result.canceled.length}, Failed: ${result.failed.length}`);
    if (result.failed.length > 0) {
      console.log('Failures:', result.failed.slice(0, 5));
    }
  }
} catch (err) {
  console.error('Error:', err.message);
  if (err.details) console.error('Details:', JSON.stringify(err.details));
}
