/**
 * Position Utilities
 * 
 * This module provides consistent utility functions for determining open positions
 * by analyzing orders and fills data rather than relying on the positions table.
 * 
 * These utilities implement the "source of truth" approach where positions are
 * derived from filled buy orders without corresponding filled sell orders.
 */

/**
 * Derive open positions from orders and fills
 * This is the core logic for determining open positions across the system
 * 
 * @param {Array} orders - Array of orders
 * @param {Array} fills - Array of fills 
 * @param {Object} options - Additional options
 * @param {boolean} options.includeDetails - Whether to include detailed information about each position
 * @param {boolean} options.includeAggregated - Whether to include an aggregated position summary
 * @returns {Object} Object containing open positions
 */
export function deriveOpenPositionsFromOrdersAndFills(orders, fills, options = {}) {
  // Set default options
  const { 
    includeDetails = true,
    includeAggregated = false
  } = options;
  
  // Create maps for quick lookups
  const fillsByOrderId = new Map();
  
  // Process fills and create lookup maps
  fills.forEach(fill => {
    const orderId = fill.orderId || fill.id;
    if (!fillsByOrderId.has(orderId)) {
      fillsByOrderId.set(orderId, []);
    }
    fillsByOrderId.get(orderId).push(fill);
  });
  
  // Create a map of sell orders by parentOrderId
  const sellOrdersByParentId = new Map();
  orders.forEach(order => {
    if (order.side === 'sell' && order.parentOrderId) {
      if (!sellOrdersByParentId.has(order.parentOrderId)) {
        sellOrdersByParentId.set(order.parentOrderId, []);
      }
      sellOrdersByParentId.get(order.parentOrderId).push(order);
    }
  });
  
  // Find buy orders with fills
  const buyOrdersWithFills = orders.filter(order => 
    order.side === 'buy' && fillsByOrderId.has(order.id) && fillsByOrderId.get(order.id).length > 0
  );
  
  // If no buy orders with fills, return empty result
  if (buyOrdersWithFills.length === 0) {
    return {
      openPositions: [],
      aggregatedPosition: null,
      totalOpenPositions: 0,
      totalSize: 0,
      totalValue: 0
    };
  }
  
  // Find buy orders that don't have matching sell orders with fills
  const openPositions = [];
  let totalSize = 0;
  let totalValue = 0;
  let earliestTimestamp = Date.now();
  const contributingOrderIds = [];
  let symbol = null;
  
  for (const buyOrder of buyOrdersWithFills) {
    // Get buy fills
    const buyFills = fillsByOrderId.get(buyOrder.id) || [];
    if (buyFills.length === 0) continue; // Skip if no fills
    
    // Check if this buy order has any sell orders with fills
    const sellOrders = sellOrdersByParentId.get(buyOrder.id) || [];
    const sellOrdersWithFills = sellOrders.filter(sellOrder => 
      fillsByOrderId.has(sellOrder.id) && fillsByOrderId.get(sellOrder.id).length > 0
    );
    
    // If no sell orders with fills, this is an open position
    if (sellOrdersWithFills.length === 0) {
      // Calculate total buy size
      const size = buyFills.reduce((sum, fill) => sum + parseFloat(fill.size || fill.quantity || 0), 0);
      if (size <= 0) continue; // Skip zero-sized positions
      
      // Calculate weighted average fill price for the buy
      const fillValue = buyFills.reduce((sum, fill) => 
        sum + (parseFloat(fill.price || fill.fillPrice || 0) * parseFloat(fill.size || fill.quantity || 0)), 0);
      const avgPrice = size > 0 ? fillValue / size : parseFloat(buyOrder.price || 0);
      
      // Set symbol if not already set
      if (!symbol) {
        symbol = buyOrder.symbol;
      }
      
      // Find open sell orders for this buy
      const openSellOrders = sellOrders.filter(order => 
        order.status === 'open' || order.status === 'pending'
      );
      
      // Create position object with minimal required fields
      const position = {
        id: buyOrder.id,
        symbol: buyOrder.symbol,
        side: 'buy',
        entryPrice: avgPrice,
        size: size,
        timestamp: buyFills[0]?.timestamp || buyOrder.filledAt || buyOrder.createdAt,
        status: 'open'
      };
      
      // Add optional fields if detailed info is requested
      if (includeDetails) {
        position.orderId = buyOrder.id;
        position.currentValue = size * avgPrice;
        position.openSellOrderId = openSellOrders.length > 0 ? openSellOrders[0].id : null;
        position.openSellOrders = openSellOrders.map(order => ({
          id: order.id,
          price: parseFloat(order.price),
          size: parseFloat(order.size),
          status: order.status
        }));
      }
      
      openPositions.push(position);
      
      // Update aggregated position data
      totalSize += size;
      totalValue += size * avgPrice;
      contributingOrderIds.push(buyOrder.id);
      
      // Track earliest timestamp
      const orderTimestamp = buyFills[0]?.timestamp || buyOrder.filledAt || buyOrder.createdAt;
      if (orderTimestamp < earliestTimestamp) {
        earliestTimestamp = orderTimestamp;
      }
    }
  }
  
  // Create the aggregated position (single position for the session)
  const aggregatedPosition = (includeAggregated && openPositions.length > 0) ? {
    id: `aggregated-position-${symbol}`,
    symbol: symbol,
    side: 'buy',
    entryPrice: totalSize > 0 ? totalValue / totalSize : 0,
    size: totalSize,
    timestamp: earliestTimestamp,
    currentValue: totalValue,
    orderIds: contributingOrderIds,
    status: 'open'
  } : null;
  
  return {
    openPositions,
    aggregatedPosition,
    totalOpenPositions: openPositions.length,
    totalSize,
    totalValue
  };
}

/**
 * Check if a session has any open positions
 * Simplified version that only checks if there are open positions
 * without returning the full position details
 * 
 * @param {Array} orders - Array of orders
 * @param {Array} fills - Array of fills
 * @returns {boolean} True if the session has open positions
 */
export function hasOpenPositions(orders, fills) {
  // Create maps for quick lookups
  const fillsByOrderId = new Map();
  
  // Process fills and create lookup maps
  fills.forEach(fill => {
    const orderId = fill.orderId || fill.id;
    if (!fillsByOrderId.has(orderId)) {
      fillsByOrderId.set(orderId, true);
    }
  });
  
  // Create a map of filled sell orders by parentOrderId
  const filledSellsByParentId = new Map();
  orders.forEach(order => {
    if (order.side === 'sell' && 
        order.status === 'filled' && 
        order.parentOrderId &&
        fillsByOrderId.has(order.id)) {
      filledSellsByParentId.set(order.parentOrderId, true);
    }
  });
  
  // Find any filled buy order without a corresponding filled sell order
  return orders.some(order => 
    order.side === 'buy' && 
    order.status === 'filled' && 
    fillsByOrderId.has(order.id) && 
    !filledSellsByParentId.has(order.id)
  );
}

/**
 * Get the count of open positions
 * Lightweight version that just returns the count without the position details
 * 
 * @param {Array} orders - Array of orders
 * @param {Array} fills - Array of fills
 * @returns {number} Number of open positions
 */
export function countOpenPositions(orders, fills) {
  // Create maps for quick lookups
  const fillsByOrderId = new Map();
  
  // Process fills and create lookup maps
  fills.forEach(fill => {
    const orderId = fill.orderId || fill.id;
    if (!fillsByOrderId.has(orderId)) {
      fillsByOrderId.set(orderId, []);
    }
    fillsByOrderId.get(orderId).push(fill);
  });
  
  // Create a map of sell orders by parentOrderId
  const sellOrdersByParentId = new Map();
  orders.forEach(order => {
    if (order.side === 'sell' && order.parentOrderId) {
      if (!sellOrdersByParentId.has(order.parentOrderId)) {
        sellOrdersByParentId.set(order.parentOrderId, []);
      }
      sellOrdersByParentId.get(order.parentOrderId).push(order);
    }
  });
  
  // Find buy orders with fills
  const buyOrdersWithFills = orders.filter(order => 
    order.side === 'buy' && fillsByOrderId.has(order.id)
  );
  
  // Count how many of these buy orders don't have matching filled sell orders
  let count = 0;
  
  for (const buyOrder of buyOrdersWithFills) {
    const sellOrders = sellOrdersByParentId.get(buyOrder.id) || [];
    const sellOrdersWithFills = sellOrders.filter(sellOrder => 
      fillsByOrderId.has(sellOrder.id)
    );
    
    if (sellOrdersWithFills.length === 0) {
      count++;
    }
  }
  
  return count;
}
