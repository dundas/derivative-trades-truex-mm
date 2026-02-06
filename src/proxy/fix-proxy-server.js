const net = require('net');
const crypto = require('crypto');
require('dotenv').config({ path: '.env' });

const FIX_PROXY_PORT = 3004;
const TRUEX_FIX_HOST = process.env.TRUEX_UPSTREAM_HOST || '38.32.101.229';
const TRUEX_FIX_PORT = parseInt(process.env.TRUEX_UPSTREAM_PORT || '19484');

console.log('🔌 Starting FIX Protocol Proxy Server');
console.log('=====================================');
console.log(`Proxy listening on port: ${FIX_PROXY_PORT}`);
console.log(`Forwarding to: ${TRUEX_FIX_HOST}:${TRUEX_FIX_PORT}`);
console.log('');

// Create proxy server
const server = net.createServer((clientSocket) => {
  const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
  console.log(`✅ Client connected from: ${clientAddr}`);
  
  // Create connection to TrueX FIX server
  const truexSocket = new net.Socket();
  
  // Set up bi-directional pipe
  let truexConnected = false;
  
  truexSocket.connect(TRUEX_FIX_PORT, TRUEX_FIX_HOST, () => {
    console.log(`✅ Connected to TrueX FIX server for client ${clientAddr}`);
    truexConnected = true;
  });
  
  // Forward data from client to TrueX
  clientSocket.on('data', (data) => {
    if (truexConnected) {
      console.log(`📤 Client -> TrueX (${data.length} bytes)`);
      // Log FIX message type if we can detect it
      const msgMatch = data.toString().match(/35=([A-Z0-9])/);
      if (msgMatch) {
        const msgType = msgMatch[1];
        const msgTypes = {
          'A': 'Logon',
          '0': 'Heartbeat',
          '1': 'Test Request',
          '2': 'Resend Request',
          '3': 'Reject',
          '4': 'Sequence Reset',
          '5': 'Logout',
          '8': 'Execution Report',
          'D': 'New Order Single',
          'F': 'Order Cancel Request'
        };
        console.log(`   Message Type: ${msgType} (${msgTypes[msgType] || 'Unknown'})`);
      }
      truexSocket.write(data);
    }
  });
  
  // Forward data from TrueX to client
  truexSocket.on('data', (data) => {
    console.log(`📨 TrueX -> Client (${data.length} bytes)`);
    // Log FIX message type if we can detect it
    const msgMatch = data.toString().match(/35=([A-Z0-9])/);
    if (msgMatch) {
      const msgType = msgMatch[1];
      const msgTypes = {
        'A': 'Logon',
        '0': 'Heartbeat',
        '1': 'Test Request',
        '2': 'Resend Request',
        '3': 'Reject',
        '4': 'Sequence Reset',
        '5': 'Logout',
        '8': 'Execution Report',
        'j': 'Business Message Reject'
      };
      console.log(`   Message Type: ${msgType} (${msgTypes[msgType] || 'Unknown'})`);
    }
    clientSocket.write(data);
  });
  
  // Handle errors
  clientSocket.on('error', (err) => {
    console.error(`❌ Client socket error: ${err.message}`);
    truexSocket.destroy();
  });
  
  truexSocket.on('error', (err) => {
    console.error(`❌ TrueX socket error: ${err.message}`);
    clientSocket.destroy();
  });
  
  // Handle disconnections
  clientSocket.on('close', () => {
    console.log(`🔌 Client disconnected: ${clientAddr}`);
    truexSocket.destroy();
  });
  
  truexSocket.on('close', () => {
    console.log(`🔌 TrueX connection closed for client ${clientAddr}`);
    clientSocket.destroy();
  });
});

// Start listening
server.listen(FIX_PROXY_PORT, '0.0.0.0', () => {
  console.log(`✅ FIX proxy server listening on port ${FIX_PROXY_PORT}`);
  console.log('');
  console.log('To connect from your local machine:');
  console.log(`  Host: <DigitalOcean-IP>`);
  console.log(`  Port: ${FIX_PROXY_PORT}`);
  console.log('');
});

// Handle server errors
server.on('error', (err) => {
  console.error('💥 Server error:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down FIX proxy server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});