/**
 * Pricing utilities for TrueX Market Maker
 */

/**
 * Get the quote tick size for a given price
 * This determines the minimum price increment for orders
 * 
 * @param {number} price - The price to get tick size for
 * @param {number} defaultTick - Default tick size (fallback)
 * @returns {number} - The tick size
 */
export function getQuoteTick(price, defaultTick = 0.50) {
    // TrueX specific tick sizes based on price ranges
    // These can be adjusted based on exchange rules
    
    if (price < 10) {
        return 0.01;
    } else if (price < 100) {
        return 0.10;
    } else if (price < 1000) {
        return 0.50;
    } else if (price < 10000) {
        return 1.00;
    } else {
        return 5.00;
    }
}

/**
 * Round a value to the nearest tick
 * 
 * @param {number} value - Value to round
 * @param {number} tickSize - Tick size to round to
 * @returns {number} - Rounded value
 */
export function roundToTick(value, tickSize) {
    return Math.round(value / tickSize) * tickSize;
}

/**
 * Calculate spread percentage between bid and ask
 * 
 * @param {number} bid - Bid price
 * @param {number} ask - Ask price
 * @returns {number} - Spread as a percentage
 */
export function calculateSpread(bid, ask) {
    if (bid === 0) return 0;
    return ((ask - bid) / bid) * 100;
}

/**
 * Calculate mid price between bid and ask
 * 
 * @param {number} bid - Bid price
 * @param {number} ask - Ask price
 * @returns {number} - Mid price
 */
export function calculateMidPrice(bid, ask) {
    return (bid + ask) / 2;
}

/**
 * Adjust price by a percentage
 * 
 * @param {number} price - Base price
 * @param {number} percentage - Percentage to adjust (e.g., 0.01 for 1%)
 * @param {boolean} increase - Whether to increase (true) or decrease (false)
 * @returns {number} - Adjusted price
 */
export function adjustPriceByPercentage(price, percentage, increase = true) {
    const multiplier = increase ? (1 + percentage) : (1 - percentage);
    return price * multiplier;
}

/**
 * Calculate order price at a given level
 * 
 * @param {number} basePrice - Starting price
 * @param {number} interval - Interval percentage between levels
 * @param {number} level - Order level (positive for sells, negative for buys)
 * @param {number} tickSize - Tick size for rounding
 * @returns {number} - Order price at the given level
 */
export function calculateOrderPrice(basePrice, interval, level, tickSize) {
    const price = basePrice * Math.pow(1 + interval, Math.abs(level));
    return roundToTick(price, tickSize);
}

/**
 * Check if price has moved significantly
 * 
 * @param {number} oldPrice - Previous price
 * @param {number} newPrice - New price
 * @param {number} threshold - Threshold percentage for significant move
 * @returns {boolean} - True if price has moved significantly
 */
export function hasPriceMovedSignificantly(oldPrice, newPrice, threshold) {
    if (oldPrice === 0) return true;
    const change = Math.abs((newPrice - oldPrice) / oldPrice);
    return change > threshold;
}

/**
 * Calculate position value
 * 
 * @param {number} quantity - Position quantity
 * @param {number} price - Current price
 * @returns {number} - Position value
 */
export function calculatePositionValue(quantity, price) {
    return quantity * price;
}

/**
 * Calculate P&L
 * 
 * @param {number} entryPrice - Entry price
 * @param {number} exitPrice - Exit/current price
 * @param {number} quantity - Position quantity
 * @param {string} side - Position side ('buy' or 'sell')
 * @returns {number} - P&L
 */
export function calculatePnL(entryPrice, exitPrice, quantity, side) {
    if (side === 'buy') {
        return (exitPrice - entryPrice) * quantity;
    } else {
        return (entryPrice - exitPrice) * quantity;
    }
}

export default {
    getQuoteTick,
    roundToTick,
    calculateSpread,
    calculateMidPrice,
    adjustPriceByPercentage,
    calculateOrderPrice,
    hasPriceMovedSignificantly,
    calculatePositionValue,
    calculatePnL
};