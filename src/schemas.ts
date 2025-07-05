import { TransactionData, Transaction, Item, Address, OrderDetails } from './types';

/**
 * Create empty transaction data structure
 */
export function createEmptyTransactionData(): TransactionData {
  return {
    metadata: {
      dateRange: {
        start: '',
        end: ''
      },
      totalTransactions: 0,
      totalAmount: 0.0,
      generatedAt: new Date().toISOString(),
      scrapedAt: new Date().toISOString()
    },
    transactions: []
  };
}

/**
 * Create transaction object
 */
export function createTransaction(data: Partial<Transaction>): Transaction {
  return {
    orderId: data.orderId || '',
    date: data.date || '',
    total: data.total || 0.0,
    status: data.status || 'unknown',
    recipient: data.recipient || '',
    address: data.address || {},
    items: data.items || [],
    orderScreenshot: data.orderScreenshot || '',
    paymentMethod: data.paymentMethod || '',
    trackingNumber: data.trackingNumber || ''
  };
}

/**
 * Create item object
 */
export function createItem(data: Partial<Item>): Item {
  return {
    name: data.name || '',
    price: data.price || 0.0,
    quantity: data.quantity || 1,
    seller: data.seller || '',
    imageUrl: data.imageUrl || '',
    productUrl: data.productUrl || ''
  };
}

/**
 * Create address object
 */
export function createAddress(data: Partial<Address>): Address {
  return {
    street: data.street || '',
    city: data.city || '',
    state: data.state || '',
    zip: data.zip || '',
    full: data.full || ''
  };
}

/**
 * Create order details object
 */
export function createOrderDetails(data: Partial<OrderDetails>): OrderDetails {
  return {
    status: data.status || 'unknown',
    recipient: data.recipient || '',
    address: data.address || {},
    items: data.items || [],
    paymentMethod: data.paymentMethod || '',
    trackingNumber: data.trackingNumber || ''
  };
}