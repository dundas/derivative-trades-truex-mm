const net = require('net');
const crypto = require('crypto');
require('dotenv').config({ path: '.env' });

const FIX_PROXY_PORT = process.env.FIX_PROXY_PORT || 3004;
const TRUEX_FIX_HOST = process.env.TRUEX_FIX_HOST;
const TRUEX_FIX_PORT = process.env.TRUEX_FIX_PORT || 19484;

// Validate required environment variables
if (!TRUEX_FIX_HOST) {
  console.error('❌ TRUEX_FIX_HOST environment variable is required');
  console.error('   Please set TRUEX_FIX_HOST to the TrueX FIX server address');
  process.exit(1);
}

console.log('🔌 Starting FIXED FIX Protocol Proxy Server');
console.log('==========================================');
console.log(`Proxy listening on port: ${FIX_PROXY_PORT}`);
console.log(`Forwarding to: ${TRUEX_FIX_HOST}:${TRUEX_FIX_PORT}`);
console.log('');

// Create proxy server
const server = net.createServer((clientSocket) => {
  const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
  console.log(`✅ Client connected from: ${clientAddr}`);
  
  // Create connection to TrueX FIX server
  let truexSocket = new net.Socket();
  
  // Set up connection state and buffer
  let truexConnected = false;
  let dataBuffer = [];
  
  truexSocket.connect(TRUEX_FIX_PORT, TRUEX_FIX_HOST, () => {
    console.log(`✅ Connected to TrueX FIX server for client ${clientAddr}`);
    truexConnected = true;
    
    // Send any buffered data now that connection is ready
    if (dataBuffer.length > 0) {
      console.log(`📤 Sending ${dataBuffer.length} buffered messages to TrueX`);
      dataBuffer.forEach(data => {
        console.log(`📤 Client -> TrueX (${data.length} bytes - from buffer)`);
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
      });
      dataBuffer = []; // Clear buffer
    }
  });
  
  // Forward data from client to TrueX (with buffering for race condition)
  clientSocket.on('data', (data) => {
    console.log(`📥 Received data from client (${data.length} bytes)`);
    
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
    } else {
      console.log(`📦 Buffering data - TrueX not connected yet (${data.length} bytes)`);
      dataBuffer.push(data);
    }
  });
  
  // Note: TrueX socket event handlers are now managed by setupTrueXSocketHandlers function
  
  // Connection recovery variables
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  const baseReconnectDelay = 1000; // 1 second
  const maxReconnectDelay = 30000; // 30 seconds
  
  // Function to attempt reconnection to TrueX
  function attemptTrueXReconnection() {
    if (reconnectAttempts >= maxReconnectAttempts) {
      console.log(`❌ Max reconnection attempts (${maxReconnectAttempts}) reached for client ${clientAddr}`);
      clientSocket.destroy();
      return;
    }
    
    reconnectAttempts++;
    const delay = Math.min(baseReconnectDelay * Math.pow(2, reconnectAttempts - 1), maxReconnectDelay);
    
    console.log(`🔄 Attempting TrueX reconnection ${reconnectAttempts}/${maxReconnectAttempts} in ${delay}ms for client ${clientAddr}`);
    
    setTimeout(() => {
      const newTrueXSocket = new net.Socket();
      
      newTrueXSocket.connect(TRUEX_FIX_PORT, TRUEX_FIX_HOST, () => {
        console.log(`✅ TrueX reconnection successful for client ${clientAddr}`);
        truexConnected = true;
        reconnectAttempts = 0; // Reset on successful connection
        
        // Replace the old socket with the new one
        truexSocket = newTrueXSocket;
        
        // Set up event handlers for the new socket
        setupTrueXSocketHandlers(newTrueXSocket);
        
        // Send any buffered data
        if (dataBuffer.length > 0) {
          console.log(`📤 Sending ${dataBuffer.length} buffered messages after reconnection`);
          dataBuffer.forEach(data => {
            newTrueXSocket.write(data);
          });
          dataBuffer = [];
        }
      });
      
      // Only handle connection errors during initial connection attempt
      // setupTrueXSocketHandlers will handle ongoing errors after successful connection
      newTrueXSocket.on('error', (error) => {
        console.log(`❌ TrueX reconnection failed for client ${clientAddr}: ${error.message}`);
        // Only retry if we haven't successfully connected yet
        if (!truexConnected) {
          attemptTrueXReconnection();
        }
      });
      
    }, delay);
  }
  
  // Function to set up TrueX socket event handlers
  function setupTrueXSocketHandlers(socket) {
    socket.on('data', (data) => {
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
          'D': 'New Order Single',
          'F': 'Order Cancel Request'
        };
        console.log(`   Message Type: ${msgType} (${msgTypes[msgType] || 'Unknown'})`);
      }
      clientSocket.write(data);
    });
    
    socket.on('error', (error) => {
      console.log(`❌ TrueX connection error for client ${clientAddr}: ${error.message}`);
      truexConnected = false;
      attemptTrueXReconnection();
    });
    
    socket.on('close', () => {
      console.log(`🔌 TrueX connection closed for client ${clientAddr}`);
      truexConnected = false;
      if (!clientSocket.destroyed) {
        attemptTrueXReconnection();
      }
    });
  }
  
  // Set up initial TrueX socket handlers
  setupTrueXSocketHandlers(truexSocket);
  
  // Handle client disconnections
  clientSocket.on('close', () => {
    console.log(`🔌 Client disconnected: ${clientAddr}`);
    truexSocket.destroy();
  });
  
  clientSocket.on('error', (error) => {
    console.log(`❌ Client connection error for ${clientAddr}: ${error.message}`);
    truexSocket.destroy();
  });
});

// Start listening (localhost only for security)
server.listen(FIX_PROXY_PORT, '127.0.0.1', () => {
  console.log(`✅ FIXED FIX proxy server listening on localhost:${FIX_PROXY_PORT}`);
  console.log('🔒 Security: Bound to localhost only (127.0.0.1)');
  console.log('');
  console.log('🔧 FIXES APPLIED:');
  console.log('  - Data buffering for race condition');
  console.log('  - Enhanced logging for debugging');
  console.log('  - Localhost-only binding for security');
  console.log('  - Automatic buffer flush when TrueX connects');
  console.log('  - Connection recovery with exponential backoff');
  console.log('  - Graceful error handling and reconnection');
  console.log('');
});

// Handle server errors
server.on('error', (err) => {
  console.error('💥 Server error:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down FIXED FIX proxy server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});