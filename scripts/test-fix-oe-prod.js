/**
 * Prod FIX Order Entry test — logon only, no orders placed
 * Verifies TRUEX_PROD_OE authentication works before live trading.
 *
 * Run: bun scripts/test-fix-oe-prod.js
 */
import net from 'net';
import crypto from 'crypto';

const SOH = '\x01';
const HOST = '127.0.0.1';
const PORT = 19484;
const SENDER = process.env.TRUEX_SENDER_COMP_ID || 'DAVID1';
const TARGET = 'TRUEX_PROD_OE';
const API_KEY = process.env.TRUEX_PROD_API_KEY || process.env.TRUEX_API_KEY;
const API_SECRET = process.env.TRUEX_PROD_SECRET_KEY || process.env.TRUEX_SECRET_KEY;

function ts() {
  const n = new Date();
  const pad = (v, l = 2) => String(v).padStart(l, '0');
  return `${n.getUTCFullYear()}${pad(n.getUTCMonth()+1)}${pad(n.getUTCDate())}-${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}:${pad(n.getUTCSeconds())}.${pad(n.getUTCMilliseconds(), 3)}`;
}

function buildFIX(fields) {
  const body = Object.entries(fields).map(([k, v]) => `${k}=${v}${SOH}`).join('');
  const len = Buffer.byteLength(body, 'utf8');
  const raw = `8=FIXT.1.1${SOH}9=${len}${SOH}` + body;
  const sum = [...Buffer.from(raw, 'utf8')].reduce((a, b) => a + b, 0) % 256;
  return raw + `10=${String(sum).padStart(3, '0')}${SOH}`;
}

function prettyFIX(raw) {
  return raw.replace(/\x01/g, ' | ');
}

const sending = ts();
const sig = crypto.createHmac('sha256', API_SECRET)
  .update(`${sending}A1${SENDER}${TARGET}${API_KEY}`)
  .digest('base64');

const logon = buildFIX({
  35: 'A', 49: SENDER, 56: TARGET, 34: '1', 52: sending,
  98: '0', 108: '30', 141: 'Y', 553: API_KEY, 554: sig,
  1137: 'FIX.5.0SP2',
});

console.log(`Connecting to ${HOST}:${PORT} (tunneled → 10.20.6.11:19484)`);
console.log(`SenderCompID: ${SENDER}, TargetCompID: ${TARGET}`);
console.log(`API Key: ${API_KEY}\n`);

const socket = new net.Socket();
socket.connect(PORT, HOST, () => {
  console.log(`Connected. Sending logon:\n${prettyFIX(logon)}\n`);
  socket.write(logon);
});

socket.on('data', (data) => {
  const msg = data.toString();
  console.log(`\n<<< SERVER:\n${prettyFIX(msg)}`);
  if (msg.includes('35=A')) {
    console.log('\n✅ LOGON ACCEPTED — prod order entry authenticated');
  } else if (msg.includes('35=3')) {
    const reason = msg.match(/58=([^\x01]+)/)?.[1] || 'unknown';
    console.log(`\n❌ REJECTED: ${reason}`);
  }
  setTimeout(() => socket.destroy(), 1000);
});

socket.on('error', (e) => console.error('Error:', e.message));
socket.on('close', () => console.log('\nConnection closed.'));
setTimeout(() => socket.destroy(), 10000);
