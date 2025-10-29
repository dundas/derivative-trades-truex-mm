import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { TrueXDataManager } from './truex-data-manager.js';

describe('TrueXDataManager', () => {
  let dataManager;
  let mockLogger;
  
  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    
    dataManager = new TrueXDataManager({
      logger: mockLogger,
      flushInterval: 1000,
      maxBatchSize: 100,
      maxOrderAge: 3600000
    });
  });
  
  describe('Constructor', () => {
    it('should initialize with correct configuration', () => {
      expect(dataManager.flushInterval).toBe(1000);
      expect(dataManager.maxBatchSize).toBe(100);
      expect(dataManager.maxOrderAge).toBe(3600000);
    });
    
    it('should initialize empty data structures', () => {
      expect(dataManager.orders.size).toBe(0);
      expect(dataManager.ordersByExchangeId.size).toBe(0);
      expect(dataManager.fills.size).toBe(0);
      expect(dataManager.fillsByExecId.size).toBe(0);
      expect(dataManager.ohlcBuffer.length).toBe(0);
    });
    
    it('should initialize empty pending writes queues', () => {
      expect(dataManager.pendingWrites.orders).toEqual([]);
      expect(dataManager.pendingWrites.fills).toEqual([]);
      expect(dataManager.pendingWrites.ohlc).toEqual([]);
    });
    
    it('should initialize stats', () => {
      const stats = dataManager.getStats();
      expect(stats.ordersInMemory).toBe(0);
      expect(stats.fillsInMemory).toBe(0);
      expect(stats.totalOrdersProcessed).toBe(0);
      expect(stats.totalFillsProcessed).toBe(0);
    });
  });
  
  describe('addOrder()', () => {
    it('should add order to memory', () => {
      const order = {
        orderId: 'order-123',
        symbol: 'BTC/USD',
        side: 'buy',
        size: 0.1,
        price: 50000,
        status: 'PENDING'
      };
      
      const result = dataManager.addOrder(order);
      
      expect(result).toBe(order);
      expect(dataManager.orders.get('order-123')).toBe(order);
      expect(dataManager.getStats().ordersInMemory).toBe(1);
    });
    
    it('should add order to exchangeOrderId index', () => {
      const order = {
        orderId: 'order-123',
        exchangeOrderId: 'TRUEX-456',
        symbol: 'BTC/USD'
      };
      
      dataManager.addOrder(order);
      
      expect(dataManager.ordersByExchangeId.get('TRUEX-456')).toBe(order);
    });
    
    it('should add order to pending writes queue', () => {
      const order = { orderId: 'order-123', symbol: 'BTC/USD' };
      
      dataManager.addOrder(order);
      
      expect(dataManager.pendingWrites.orders).toContain(order);
    });
    
    it('should throw error if orderId is missing', () => {
      const order = { symbol: 'BTC/USD' };
      
      expect(() => dataManager.addOrder(order)).toThrow('Order must have orderId');
    });
    
    it('should update stats', () => {
      dataManager.addOrder({ orderId: 'order-1', symbol: 'BTC/USD' });
      dataManager.addOrder({ orderId: 'order-2', symbol: 'BTC/USD' });
      
      const stats = dataManager.getStats();
      expect(stats.ordersInMemory).toBe(2);
      expect(stats.totalOrdersProcessed).toBe(2);
    });
  });
  
  describe('getOrder()', () => {
    it('should retrieve order by orderId', () => {
      const order = { orderId: 'order-123', symbol: 'BTC/USD' };
      dataManager.addOrder(order);
      
      const retrieved = dataManager.getOrder('order-123');
      
      expect(retrieved).toBe(order);
    });
    
    it('should return undefined for non-existent order', () => {
      const retrieved = dataManager.getOrder('non-existent');
      
      expect(retrieved).toBeUndefined();
    });
  });
  
  describe('getOrderByExchangeId()', () => {
    it('should retrieve order by exchangeOrderId', () => {
      const order = {
        orderId: 'order-123',
        exchangeOrderId: 'TRUEX-456',
        symbol: 'BTC/USD'
      };
      dataManager.addOrder(order);
      
      const retrieved = dataManager.getOrderByExchangeId('TRUEX-456');
      
      expect(retrieved).toBe(order);
    });
    
    it('should return undefined for non-existent exchangeOrderId', () => {
      const retrieved = dataManager.getOrderByExchangeId('non-existent');
      
      expect(retrieved).toBeUndefined();
    });
  });
  
  describe('updateOrder()', () => {
    it('should update order in memory', () => {
      const order = {
        orderId: 'order-123',
        symbol: 'BTC/USD',
        status: 'PENDING',
        filledSize: 0
      };
      dataManager.addOrder(order);
      
      const updated = dataManager.updateOrder('order-123', {
        status: 'FILLED',
        filledSize: 0.1
      });
      
      expect(updated.status).toBe('FILLED');
      expect(updated.filledSize).toBe(0.1);
      expect(updated.updatedAt).toBeDefined();
    });
    
    it('should update exchangeOrderId index when changed', () => {
      const order = {
        orderId: 'order-123',
        exchangeOrderId: 'TRUEX-456',
        symbol: 'BTC/USD'
      };
      dataManager.addOrder(order);
      
      dataManager.updateOrder('order-123', {
        exchangeOrderId: 'TRUEX-789'
      });
      
      expect(dataManager.ordersByExchangeId.get('TRUEX-456')).toBeUndefined();
      expect(dataManager.ordersByExchangeId.get('TRUEX-789')).toBe(order);
    });
    
    it('should add updated order to pending writes', () => {
      const order = { orderId: 'order-123', symbol: 'BTC/USD' };
      dataManager.addOrder(order);
      
      // Clear pending writes
      dataManager.pendingWrites.orders = [];
      
      dataManager.updateOrder('order-123', { status: 'FILLED' });
      
      expect(dataManager.pendingWrites.orders.length).toBe(1);
    });
    
    it('should return null for non-existent order', () => {
      const result = dataManager.updateOrder('non-existent', { status: 'FILLED' });
      
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
  
  describe('getAllOrders()', () => {
    it('should return all orders as array', () => {
      dataManager.addOrder({ orderId: 'order-1', symbol: 'BTC/USD' });
      dataManager.addOrder({ orderId: 'order-2', symbol: 'ETH/USD' });
      
      const orders = dataManager.getAllOrders();
      
      expect(orders).toHaveLength(2);
      expect(orders[0].orderId).toBe('order-1');
      expect(orders[1].orderId).toBe('order-2');
    });
    
    it('should return empty array when no orders', () => {
      const orders = dataManager.getAllOrders();
      
      expect(orders).toEqual([]);
    });
  });
  
  describe('addFill()', () => {
    it('should add fill to memory', () => {
      const fill = {
        fillId: 'fill-123',
        execID: 'EXEC-456',
        orderId: 'order-123',
        quantity: 0.1,
        price: 50000
      };
      
      const result = dataManager.addFill(fill);
      
      expect(result).toBe(fill);
      expect(dataManager.fills.get('fill-123')).toBe(fill);
      expect(dataManager.fillsByExecId.get('EXEC-456')).toBe(fill);
    });
    
    it('should detect and skip duplicate fills by execID', () => {
      const fill1 = {
        fillId: 'fill-123',
        execID: 'EXEC-456',
        orderId: 'order-123'
      };
      const fill2 = {
        fillId: 'fill-789',
        execID: 'EXEC-456',  // Same execID
        orderId: 'order-123'
      };
      
      dataManager.addFill(fill1);
      const result = dataManager.addFill(fill2);
      
      expect(result).toBeNull();
      expect(dataManager.fills.size).toBe(1);
      expect(dataManager.getStats().duplicateFillsSkipped).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
    
    it('should add fill to pending writes queue', () => {
      const fill = {
        fillId: 'fill-123',
        execID: 'EXEC-456',
        orderId: 'order-123'
      };
      
      dataManager.addFill(fill);
      
      expect(dataManager.pendingWrites.fills).toContain(fill);
    });
    
    it('should throw error if fillId is missing', () => {
      const fill = { execID: 'EXEC-456' };
      
      expect(() => dataManager.addFill(fill)).toThrow('Fill must have fillId');
    });
    
    it('should throw error if execID is missing', () => {
      const fill = { fillId: 'fill-123' };
      
      expect(() => dataManager.addFill(fill)).toThrow('Fill must have execID for deduplication');
    });
    
    it('should update stats', () => {
      dataManager.addFill({ fillId: 'fill-1', execID: 'EXEC-1', orderId: 'order-1' });
      dataManager.addFill({ fillId: 'fill-2', execID: 'EXEC-2', orderId: 'order-1' });
      
      const stats = dataManager.getStats();
      expect(stats.fillsInMemory).toBe(2);
      expect(stats.totalFillsProcessed).toBe(2);
    });
  });
  
  describe('getFill()', () => {
    it('should retrieve fill by fillId', () => {
      const fill = { fillId: 'fill-123', execID: 'EXEC-456', orderId: 'order-123' };
      dataManager.addFill(fill);
      
      const retrieved = dataManager.getFill('fill-123');
      
      expect(retrieved).toBe(fill);
    });
  });
  
  describe('getFillByExecId()', () => {
    it('should retrieve fill by execID', () => {
      const fill = { fillId: 'fill-123', execID: 'EXEC-456', orderId: 'order-123' };
      dataManager.addFill(fill);
      
      const retrieved = dataManager.getFillByExecId('EXEC-456');
      
      expect(retrieved).toBe(fill);
    });
  });
  
  describe('getAllFills()', () => {
    it('should return all fills as array', () => {
      dataManager.addFill({ fillId: 'fill-1', execID: 'EXEC-1', orderId: 'order-1' });
      dataManager.addFill({ fillId: 'fill-2', execID: 'EXEC-2', orderId: 'order-1' });
      
      const fills = dataManager.getAllFills();
      
      expect(fills).toHaveLength(2);
    });
  });
  
  describe('addOHLC()', () => {
    it('should add OHLC candle to buffer', () => {
      const candle = {
        symbol: 'BTC/USD',
        interval: '1m',
        timestamp: Date.now(),
        open: 50000,
        high: 50100,
        low: 49900,
        close: 50050,
        volume: 10
      };
      
      const result = dataManager.addOHLC(candle);
      
      expect(result).toBe(candle);
      expect(dataManager.ohlcBuffer).toContain(candle);
    });
    
    it('should add OHLC to pending writes queue', () => {
      const candle = {
        symbol: 'BTC/USD',
        interval: '1m',
        timestamp: Date.now(),
        open: 50000,
        close: 50050
      };
      
      dataManager.addOHLC(candle);
      
      expect(dataManager.pendingWrites.ohlc).toContain(candle);
    });
    
    it('should throw error if timestamp is missing', () => {
      const candle = { symbol: 'BTC/USD', open: 50000 };
      
      expect(() => dataManager.addOHLC(candle)).toThrow('OHLC candle must have timestamp');
    });
  });
  
  describe('getOHLCBuffer()', () => {
    it('should return copy of OHLC buffer', () => {
      const candle = { symbol: 'BTC/USD', interval: '1m', timestamp: Date.now() };
      dataManager.addOHLC(candle);
      
      const buffer = dataManager.getOHLCBuffer();
      
      expect(buffer).toHaveLength(1);
      expect(buffer).not.toBe(dataManager.ohlcBuffer); // Should be a copy
    });
  });
  
  describe('addExecutionReport()', () => {
    it('should add execution report to memory', () => {
      const execReport = {
        execID: 'EXEC-123',
        orderId: 'order-123',
        execType: '2',
        ordStatus: '2'
      };
      
      const result = dataManager.addExecutionReport(execReport);
      
      expect(result).toBe(execReport);
      expect(dataManager.executionReports.get('EXEC-123')).toBe(execReport);
    });
    
    it('should throw error if execID is missing', () => {
      const execReport = { orderId: 'order-123' };
      
      expect(() => dataManager.addExecutionReport(execReport)).toThrow('Execution report must have execID');
    });
  });
  
  describe('getExecutionReport()', () => {
    it('should retrieve execution report by execID', () => {
      const execReport = { execID: 'EXEC-123', orderId: 'order-123' };
      dataManager.addExecutionReport(execReport);
      
      const retrieved = dataManager.getExecutionReport('EXEC-123');
      
      expect(retrieved).toBe(execReport);
    });
  });
  
  describe('getPendingOrders()', () => {
    it('should return and remove pending orders from queue', () => {
      dataManager.addOrder({ orderId: 'order-1', symbol: 'BTC/USD' });
      dataManager.addOrder({ orderId: 'order-2', symbol: 'BTC/USD' });
      
      const pending = dataManager.getPendingOrders();
      
      expect(pending).toHaveLength(2);
      expect(dataManager.pendingWrites.orders).toHaveLength(0);
    });
    
    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        dataManager.addOrder({ orderId: `order-${i}`, symbol: 'BTC/USD' });
      }
      
      const pending = dataManager.getPendingOrders(5);
      
      expect(pending).toHaveLength(5);
      expect(dataManager.pendingWrites.orders).toHaveLength(5);
    });
  });
  
  describe('getPendingFills()', () => {
    it('should return and remove pending fills from queue', () => {
      dataManager.addFill({ fillId: 'fill-1', execID: 'EXEC-1', orderId: 'order-1' });
      dataManager.addFill({ fillId: 'fill-2', execID: 'EXEC-2', orderId: 'order-1' });
      
      const pending = dataManager.getPendingFills();
      
      expect(pending).toHaveLength(2);
      expect(dataManager.pendingWrites.fills).toHaveLength(0);
    });
  });
  
  describe('getPendingOHLC()', () => {
    it('should return and remove pending OHLC from queue', () => {
      dataManager.addOHLC({ symbol: 'BTC/USD', interval: '1m', timestamp: Date.now() });
      dataManager.addOHLC({ symbol: 'BTC/USD', interval: '1m', timestamp: Date.now() + 60000 });
      
      const pending = dataManager.getPendingOHLC();
      
      expect(pending).toHaveLength(2);
      expect(dataManager.pendingWrites.ohlc).toHaveLength(0);
    });
  });
  
  describe('cleanup()', () => {
    it('should remove old completed orders', () => {
      const oldOrder = {
        orderId: 'order-old',
        symbol: 'BTC/USD',
        status: 'FILLED',
        updatedAt: Date.now() - 7200000  // 2 hours ago
      };
      const recentOrder = {
        orderId: 'order-recent',
        symbol: 'BTC/USD',
        status: 'FILLED',
        updatedAt: Date.now() - 1800000  // 30 minutes ago
      };
      
      dataManager.addOrder(oldOrder);
      dataManager.addOrder(recentOrder);
      
      const cleaned = dataManager.cleanup(3600000);  // 1 hour max age
      
      expect(cleaned).toBe(1);
      expect(dataManager.orders.has('order-old')).toBe(false);
      expect(dataManager.orders.has('order-recent')).toBe(true);
    });
    
    it('should not remove active orders', () => {
      const activeOrder = {
        orderId: 'order-active',
        symbol: 'BTC/USD',
        status: 'OPEN',
        updatedAt: Date.now() - 7200000  // 2 hours ago but still active
      };
      
      dataManager.addOrder(activeOrder);
      
      const cleaned = dataManager.cleanup(3600000);
      
      expect(cleaned).toBe(0);
      expect(dataManager.orders.has('order-active')).toBe(true);
    });
    
    it('should remove from exchangeOrderId index', () => {
      const oldOrder = {
        orderId: 'order-old',
        exchangeOrderId: 'TRUEX-123',
        symbol: 'BTC/USD',
        status: 'CANCELLED',
        updatedAt: Date.now() - 7200000
      };
      
      dataManager.addOrder(oldOrder);
      dataManager.cleanup(3600000);
      
      expect(dataManager.ordersByExchangeId.has('TRUEX-123')).toBe(false);
    });
  });
  
  describe('clearOHLCBuffer()', () => {
    it('should clear OHLC buffer', () => {
      dataManager.addOHLC({ symbol: 'BTC/USD', interval: '1m', timestamp: Date.now() });
      dataManager.addOHLC({ symbol: 'BTC/USD', interval: '1m', timestamp: Date.now() + 60000 });
      
      const count = dataManager.clearOHLCBuffer();
      
      expect(count).toBe(2);
      expect(dataManager.ohlcBuffer).toHaveLength(0);
      expect(dataManager.getStats().ohlcInMemory).toBe(0);
    });
  });
  
  describe('getStats()', () => {
    it('should return current statistics', () => {
      dataManager.addOrder({ orderId: 'order-1', symbol: 'BTC/USD' });
      dataManager.addFill({ fillId: 'fill-1', execID: 'EXEC-1', orderId: 'order-1' });
      dataManager.addOHLC({ symbol: 'BTC/USD', interval: '1m', timestamp: Date.now() });
      
      const stats = dataManager.getStats();
      
      expect(stats.ordersInMemory).toBe(1);
      expect(stats.fillsInMemory).toBe(1);
      expect(stats.ohlcInMemory).toBe(1);
      expect(stats.totalOrdersProcessed).toBe(1);
      expect(stats.totalFillsProcessed).toBe(1);
    });
  });
  
  describe('reset()', () => {
    it('should reset all data structures', () => {
      dataManager.addOrder({ orderId: 'order-1', symbol: 'BTC/USD' });
      dataManager.addFill({ fillId: 'fill-1', execID: 'EXEC-1', orderId: 'order-1' });
      dataManager.addOHLC({ symbol: 'BTC/USD', interval: '1m', timestamp: Date.now() });
      
      dataManager.reset();
      
      expect(dataManager.orders.size).toBe(0);
      expect(dataManager.fills.size).toBe(0);
      expect(dataManager.ohlcBuffer).toHaveLength(0);
      expect(dataManager.pendingWrites.orders).toHaveLength(0);
      expect(dataManager.getStats().totalOrdersProcessed).toBe(0);
    });
  });
});
