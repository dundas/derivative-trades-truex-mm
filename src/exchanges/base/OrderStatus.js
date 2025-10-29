/**
 * Order Status Constants
 * 
 * Defines the possible states of an order in the system.
 */

export const OrderStatus = {
  PENDING: 'pending',
  OPEN: 'open',
  FILLED: 'filled',
  PARTIALLY_FILLED: 'partially_filled',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
  EXPIRED: 'expired'
};

export default OrderStatus;
