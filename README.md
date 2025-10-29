# TrueX FIX Market Maker

> Production-ready FIX 5.0 SP2 market maker for TrueX exchange, extracted from [derivative-trades](https://github.com/dundas/decisivetrades) monorepo.

## 🎯 Overview

This repository contains a standalone, production-ready market maker for the TrueX exchange, implementing the FIX 5.0 SP2 protocol for high-frequency trading operations.

### Key Features

- ✅ **FIX 5.0 SP2 Protocol**: Complete implementation with HMAC-SHA256 authentication
- ✅ **Data Pipeline**: In-Memory → Redis → PostgreSQL with 1-second flush intervals
- ✅ **OHLC Generation**: Real-time candle building from fill execution reports
- ✅ **Fill Recovery System**: Automatic detection and recovery of missed fills
- ✅ **Two-Sided Market Simulation**: Complete framework for testing maker/taker dynamics
- ✅ **Coinbase Integration**: Live market data via WebSocket for accurate pricing
- ✅ **Production Security**: Zero credential exposure, comprehensive error handling
- ✅ **Comprehensive Tests**: 50+ unit and integration tests

## 📊 Architecture

```
┌─────────────────────────────────────────┐
│  Market Maker Orchestrator              │
│  - Session management                   │
│  - Order lifecycle tracking             │
│  - Balance management                   │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  FIX Protocol Layer                     │
│  - Logon/Logout/Heartbeat               │
│  - Order management (New/Cancel/Replace)│
│  - Execution reports                    │
│  - Market data requests                 │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  Data Pipeline                          │
│  ┌────────────┐  ┌──────────┐  ┌──────┐│
│  │  In-Memory │→ │  Redis   │→ │  PG  ││
│  │  (orders,  │  │ (1s      │  │(5min)││
│  │   fills)   │  │  flush)  │  │      ││
│  └────────────┘  └──────────┘  └──────┘│
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  OHLC Builder                           │
│  - Real-time candles from fills         │
│  - 1-minute intervals                   │
│  - Redis persistence                    │
└─────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18.0.0
- PostgreSQL database
- Redis instance
- TrueX UAT/Production API credentials

### Installation

```bash
# Clone the repository
git clone https://github.com/dundas/derivative-trades-truex-mm.git
cd derivative-trades-truex-mm

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials
```

### Configuration

Edit `.env` with your TrueX credentials:

```bash
TRUEX_API_KEY=your-api-key
TRUEX_API_SECRET=your-api-secret
TRUEX_CLIENT_ID=your-client-id
TRUEX_FIX_HOST=129.212.145.83
TRUEX_FIX_PORT=3004
DATABASE_URL=postgresql://...
DO_REDIS_URL=redis://...
```

### Running

```bash
# Start market maker with FIX connection
npm start

# Run with Coinbase live data
npm run start:coinbase

# Run two-sided market simulation
npm run simulate:full
```

## 📁 Repository Structure

```
derivative-trades-truex-mm/
├── src/
│   ├── core/                      # Main market maker logic
│   │   ├── truex-market-maker.js      # Core orchestrator
│   │   ├── run-truex-mm-with-fix.js   # FIX entry point
│   │   └── truex-coinbase-market-maker.js # Coinbase integration
│   ├── data-pipeline/             # Data pipeline components
│   │   ├── truex-data-manager.js      # In-memory management
│   │   ├── truex-redis-manager.js     # Redis persistence
│   │   ├── truex-postgresql-manager.js # PostgreSQL migration
│   │   ├── ohlc-builder.js            # OHLC candle generation
│   │   ├── coinbase-ws-ingest.js      # Coinbase WebSocket
│   │   └── l2-ohlc-orchestrator.js    # L2 orderbook OHLC
│   ├── fix-protocol/              # FIX 5.0 SP2 implementation
│   │   └── fix-connection.js
│   ├── simulation/                # Two-sided market simulation
│   │   ├── simulation-config.js       # Configuration system
│   │   ├── market-maker-ladder.js     # Market maker script
│   │   ├── market-taker-simple.js     # Market taker script
│   │   └── run-two-sided-market-test.js # Orchestrator
│   ├── proxy/                     # Proxy server components
│   ├── exchanges/                 # Exchange adapters
│   │   ├── base/                      # Base adapter interface
│   │   └── truex/                     # TrueX-specific adapters
│   ├── utils/                     # Utilities
│   └── config/                    # Configuration presets
├── tests/                         # Test suite (50+ tests)
├── docs/                          # Documentation (31 files)
└── scripts/                       # Utility scripts
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests
npm run test:integration

# Test single order placement
npm run test:fix

# Test data pipeline
npm run test:pipeline
```

## 📖 Documentation

Comprehensive documentation available in `/docs`:

- **Architecture & Design**: System architecture and components
- **FIX Protocol**: Complete FIX 5.0 SP2 implementation guide
- **Data Pipeline**: Pipeline specification and flow
- **Integration Guide**: Step-by-step integration instructions
- **Testing Summary**: Test results and validation
- **Troubleshooting**: Common issues and solutions

## 🔒 Security

- ✅ Zero credential exposure in logs
- ✅ HMAC-SHA256 authentication
- ✅ Environment variable validation
- ✅ Localhost-only proxy binding
- ✅ No hardcoded sensitive values
- ✅ Comprehensive error handling

## 📊 Performance

- **Latency**: Sub-100ms order placement
- **Throughput**: 50+ orders/second
- **Memory**: ~67MB baseline
- **OHLC Generation**: Real-time from fills
- **Data Pipeline**: 1s Redis flush, 5min PostgreSQL migration

## 🔄 Two-Sided Market Simulation

Complete framework for testing market maker functionality:

```bash
# Run market maker (50-order ladder)
npm run simulate:maker

# Run market taker (hits orders)
npm run simulate:taker

# Run full two-sided test
npm run simulate:full
```

### Simulation Features

- Live Coinbase price integration
- 50-order ladder generation (25 bids, 25 asks)
- Configurable spread and order sizes
- Execution tracking and statistics
- OHLC generation from fills
- Redis persistence

## 🚀 Deployment

```bash
# Build Docker image
docker build -t derivative-trades-truex-mm .

# Run with Docker Compose
docker-compose up -d

# Check logs
docker-compose logs -f truex-mm
```

## 🤝 Contributing

This repository is extracted from the main [derivative-trades](https://github.com/dundas/decisivetrades) monorepo for independent development.

## 📝 License

MIT License - see LICENSE file for details

## 🔗 Related Projects

- [derivative-trades](https://github.com/dundas/decisivetrades) - Main monorepo
- [derivative-trades-multi-pair-mm](https://github.com/dundas/derivative-trades-multi-pair-mm) - Multi-pair market maker

## 📧 Support

For issues and questions:
- GitHub Issues: [Issues](https://github.com/dundas/derivative-trades-truex-mm/issues)
- Documentation: [docs/](./docs/)

---

**Status**: ✅ Production Ready | **Last Updated**: 2025-10-29 | **Version**: 1.0.0
