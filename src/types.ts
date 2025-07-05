export interface TransactionData {
  metadata: {
    dateRange: {
      start: string;
      end: string;
    };
    totalTransactions: number;
    totalAmount: number;
    generatedAt: string;
    scrapedAt: string;
  };
  transactions: Transaction[];
}

export interface Transaction {
  orderId: string;
  date: string;
  total: number;
  status: string;
  recipient: string;
  address: Address;
  items: Item[];
  orderScreenshot: string;
  paymentMethod: string;
  trackingNumber: string;
  orderDetailsUrl?: string;
}

export interface Address {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  full?: string;
}

export interface Item {
  name: string;
  price: number;
  quantity: number;
  seller: string;
  imageUrl: string;
  productUrl: string;
}

export interface ConfigData {
  amazon: {
    email: string;
    baseUrl: string;
    paymentsUrl: string;
    orderUrlPattern: string;
  };
  scraping: {
    headless: boolean;
    timeout: number;
    delayBetweenRequests: number;
    maxRetries: number;
  };
  output: {
    dataDir: string;
    outputDir: string;
    screenshotsDir: string;
  };
  dateRange: {
    defaultDays: number;
  };
}

export interface BasicTransaction {
  orderId: string;
  date: string;
  total: number;
  orderDetailsUrl?: string;
}

export interface OrderDetails {
  status: string;
  recipient: string;
  address: Address;
  items: Item[];
  paymentMethod: string;
  trackingNumber: string;
}