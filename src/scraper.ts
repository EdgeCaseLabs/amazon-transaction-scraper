import * as fs from 'fs-extra';
import * as path from 'path';
import { format, subDays, parseISO } from 'date-fns';
import AmazonAuth from './auth';
import config from './config';
import { createEmptyTransactionData, createTransaction, createItem } from './schemas';
import { TransactionData, Transaction, BasicTransaction, OrderDetails, Item } from './types';
import { Page, ElementHandle } from 'playwright';

class AmazonScraper {
  private auth: AmazonAuth;
  private transactionData: TransactionData;
  private screenshotCounter: number = 0;

  constructor() {
    this.auth = new AmazonAuth();
    this.transactionData = createEmptyTransactionData();
  }

  async initialize(): Promise<void> {
    await this.auth.init();
    
    // Ensure output directories exist
    await fs.ensureDir(config.get('output.dataDir'));
    await fs.ensureDir(config.get('output.outputDir'));
    await fs.ensureDir(config.get('output.screenshotsDir'));
  }

  async login(email: string, password: string): Promise<boolean> {
    return await this.auth.login(email, password);
  }

  async scrapeTransactions(daysBack: number = 90): Promise<TransactionData> {
    try {
      console.log(`🔍 Scraping transactions from the last ${daysBack} days...`);
      
      const endDate = new Date();
      const startDate = subDays(endDate, daysBack);
      
      this.transactionData.metadata.dateRange = {
        start: format(startDate, 'yyyy-MM-dd'),
        end: format(endDate, 'yyyy-MM-dd')
      };
      
      // Navigate to transactions page
      await this.auth.navigateToTransactions();
      
      // Take screenshot of the transactions page
      const transactionsScreenshot = path.join(config.get('output.screenshotsDir'), 'transactions-page.png');
      await this.auth.takeScreenshot(transactionsScreenshot);
      
      // Wait for the page to load
      const page = this.auth.getPage();
      if (!page) {
        throw new Error('Browser page not initialized');
      }
      await page.waitForTimeout(3000);
      
      // Look for transaction elements (these selectors may need to be updated based on actual page structure)
      const transactions = await this.scrapeTransactionList();
      
      console.log(`📋 Found ${transactions.length} transactions`);
      
      // Process each transaction
      for (let i = 0; i < transactions.length; i++) {
        const transaction = transactions[i];
        console.log(`📦 Processing transaction ${i + 1}/${transactions.length}: ${transaction.orderId}`);
        
        try {
          const detailedTransaction = await this.scrapeOrderDetails(transaction);
          this.transactionData.transactions.push(detailedTransaction);
          
          // Add delay between requests to avoid being blocked
          const page = this.auth.getPage();
          if (page) {
            await page.waitForTimeout(config.get('scraping.delayBetweenRequests'));
          }
          
        } catch (error) {
          console.error(`❌ Error processing transaction ${transaction.orderId}:`, error);
          // Add the transaction anyway with available data
          this.transactionData.transactions.push(createTransaction(transaction));
        }
      }
      
      // Update metadata
      this.transactionData.metadata.totalTransactions = this.transactionData.transactions.length;
      this.transactionData.metadata.totalAmount = this.transactionData.transactions.reduce(
        (sum, t) => sum + (t.total || 0), 0
      );
      this.transactionData.metadata.scrapedAt = new Date().toISOString();
      
      console.log(`✅ Scraped ${this.transactionData.transactions.length} transactions`);
      console.log(`💰 Total amount: $${this.transactionData.metadata.totalAmount.toFixed(2)}`);
      
      return this.transactionData;
      
    } catch (error) {
      console.error('Error scraping transactions:', error);
      throw error;
    }
  }

  async scrapeTransactionList(): Promise<BasicTransaction[]> {
    const page = this.auth.getPage();
    if (!page) {
      throw new Error('Browser page not initialized');
    }
    
    const transactions: BasicTransaction[] = [];
    
    try {
      // Take a screenshot first to see what we're working with
      await this.auth.takeScreenshot(path.join(config.get('output.screenshotsDir'), 'page-analysis.png'));
      
      // Get page content for analysis
      const pageContent = await page.content();
      console.log('Page HTML length:', pageContent.length);
      
      // Save HTML content for analysis
      const htmlPath = path.join(config.get('output.screenshotsDir'), 'page-content.html');
      await fs.writeFile(htmlPath, pageContent, 'utf8');
      console.log(`💾 HTML content saved to: ${htmlPath}`);
      
      // Use the actual Amazon DOM structure you identified
      console.log('🔍 Using Amazon transaction DOM structure (.apx-transactions-line-item-component-container)...');
      
      let allTransactions: BasicTransaction[] = [];
      let currentPage = 1;
      
      // Process all pages of transactions
      while (true) {
        console.log(`📄 Processing page ${currentPage}...`);
        
        // Look for transaction rows using the correct class
        const transactionRows = await page.$$('.apx-transactions-line-item-component-container');
        console.log(`📋 Found ${transactionRows.length} transaction rows on page ${currentPage}`);
        
        if (transactionRows.length === 0) {
          console.log('❌ No transaction rows found on this page');
          break;
        }
        
        // Process each transaction row
        for (let i = 0; i < transactionRows.length; i++) {
          const row = transactionRows[i];
          console.log(`Processing transaction ${i + 1}/${transactionRows.length} on page ${currentPage}`);
          
          try {
            const transaction = await this.extractTransactionFromRow(row);
            if (transaction) {
              allTransactions.push(transaction);
              console.log(`✅ Extracted: ${transaction.orderId} - $${transaction.total}`);
            }
          } catch (error) {
            console.error(`❌ Error processing transaction ${i + 1}:`, error);
          }
        }
        
        // Look for "Next Page" button
        console.log('🔍 Looking for "Next Page" button...');
        const nextPageSpan = await page.$('span:has-text("Next Page")');
        
        if (nextPageSpan) {
          console.log(`📄 Found "Next Page" button, navigating to page ${currentPage + 1}...`);
          await nextPageSpan.click();
          
          // Wait for the next page to load
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(2000);
          
          currentPage++;
          
          // Take screenshot of new page
          await this.auth.takeScreenshot(path.join(config.get('output.screenshotsDir'), `page-${currentPage}.png`));
        } else {
          console.log('✅ No "Next Page" button found, reached end of transactions');
          break;
        }
        
        // Safety check to prevent infinite loops
        if (currentPage > 10) {
          console.log('⚠️ Reached maximum page limit (10), stopping pagination');
          break;
        }
      }
      
      console.log(`🎉 Total transactions found across ${currentPage} pages: ${allTransactions.length}`);
      return allTransactions;
      
    } catch (error) {
      console.error('Error scraping transaction list:', error);
      
      // Take a screenshot for debugging
      await this.auth.takeScreenshot(path.join(config.get('output.screenshotsDir'), 'scrape-error-debug.png'));
      
      // Try to get any visible text for debugging
      const bodyText = await page.textContent('body');
      console.log('Page content preview:', bodyText?.substring(0, 500) || 'No content found');
    }
    
    return transactions;
  }

  async extractTransactionFromRow(row: ElementHandle): Promise<BasicTransaction | null> {
    try {
      // Get text content from the row for analysis
      const rowText = await row.textContent();
      console.log(`Row text sample:`, rowText?.substring(0, 200));
      
      // Look for order ID links within the row
      const orderLink = await row.$('a[href*="order"], a[href*="gp/your-account"]');
      let orderId = '';
      let orderDetailsUrl = '';
      
      if (orderLink) {
        const href = await orderLink.getAttribute('href');
        if (href) {
          orderDetailsUrl = href.startsWith('http') ? href : config.get('amazon.baseUrl') + href;
          
          // Extract order ID from URL
          const orderIdMatch = href.match(/orderID=([^&]+)/);
          if (orderIdMatch) {
            orderId = orderIdMatch[1];
          }
        }
      }
      
      // Look for amount in the row
      let total = 0;
      if (rowText) {
        const amountMatch = rowText.match(/\$(\d+(?:,\d{3})*(?:\.\d{2})?)/);
        if (amountMatch) {
          total = parseFloat(amountMatch[1].replace(',', ''));
        }
      }
      
      // If we don't have basic info, try text patterns
      if (!orderId && rowText) {
        const orderIdMatch = rowText.match(/(D\d{2}-\d{7}-\d{7})/);
        if (orderIdMatch) {
          orderId = orderIdMatch[1];
          orderDetailsUrl = `https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}`;
        }
      }
      
      if (orderId || total > 0) {
        return {
          orderId: orderId || `unknown-${Date.now()}`,
          date: '', // Will be filled from order page
          total,
          orderDetailsUrl
        };
      }
      
      return null;
    } catch (error) {
      console.error('Error extracting transaction from row:', error);
      return null;
    }
  }

  async extractTransactionFromElement(element: ElementHandle): Promise<BasicTransaction | null> {
    const page = this.auth.getPage();
    
    try {
      // Get all text content from the element first for analysis
      const elementText = await element.textContent();
      console.log(`Analyzing element text:`, elementText?.substring(0, 300));
      
      // Try multiple patterns for order ID links (based on Amazon transaction page)
      const orderIdSelectors = [
        '[href*="order-details"]',
        '[href*="orderID"]', 
        'a[href*="order"]',
        'a[href*="gp/your-account"]',
        'a[href*="gp/css"]',           // Amazon account links
        'a[href*="/dp/"]',
        'a[href*="amazon.com"]',
        'a[href*="D"]',                // Order numbers often start with D
        'a[color="blue"]',             // Amazon blue links
        '.a-link-normal',              // Amazon's standard link class
        'a', // Any link as fallback
      ];
      
      // Try multiple patterns for dates
      const dateSelectors = [
        '.date',
        '.order-date', 
        '[data-testid="order-date"]',
        '[class*="date"]',
        '[data-date]',
        'time',
        // Look for text patterns that might be dates
        'span:has-text("/")',
        'div:has-text("/")',
      ];
      
      // Try multiple patterns for amounts/totals
      const totalSelectors = [
        '.total',
        '.order-total', 
        '.amount',
        '[class*="total"]',
        '[class*="amount"]',
        '[class*="price"]',
        // Look for text patterns with dollar signs
        'span:has-text("$")',
        'div:has-text("$")',
      ];
      
      let orderIdElement = null;
      let dateElement = null;
      let totalElement = null;
      
      // Find order ID element
      for (const selector of orderIdSelectors) {
        orderIdElement = await element.$(selector);
        if (orderIdElement) {
          console.log(`Found order ID element with selector: ${selector}`);
          break;
        }
      }
      
      // Find date element  
      for (const selector of dateSelectors) {
        dateElement = await element.$(selector);
        if (dateElement) {
          console.log(`Found date element with selector: ${selector}`);
          break;
        }
      }
      
      // Find total element
      for (const selector of totalSelectors) {
        totalElement = await element.$(selector);
        if (totalElement) {
          console.log(`Found total element with selector: ${selector}`);
          break;
        }
      }
      
      let orderId = '';
      if (orderIdElement) {
        const href = await orderIdElement.getAttribute('href');
        if (href) {
          const orderIdMatch = href.match(/orderID=([^&]+)/);
          if (orderIdMatch) {
            orderId = orderIdMatch[1];
          }
        }
      }
      
      let date = '';
      if (dateElement) {
        const dateText = await dateElement.textContent();
        if (dateText) {
          date = dateText.trim();
        }
      }
      
      let total = 0;
      if (totalElement) {
        const totalText = await totalElement.textContent();
        if (totalText) {
          const totalMatch = totalText.match(/\$?([\d,]+\.?\d*)/);
          if (totalMatch) {
            total = parseFloat(totalMatch[1].replace(',', ''));
          }
        }
      }
      
      // Get the order details link
      let orderDetailsUrl = '';
      if (orderIdElement) {
        const href = await orderIdElement.getAttribute('href');
        if (href) {
          orderDetailsUrl = href;
          if (!orderDetailsUrl.startsWith('http')) {
            orderDetailsUrl = config.get('amazon.baseUrl') + orderDetailsUrl;
          }
        }
      }
      
      // If we didn't find specific elements, try text pattern matching as fallback
      if (!orderId && !date && !total) {
        console.log('🔍 No specific elements found, trying text pattern matching...');
        
        if (elementText) {
          // Look for order ID patterns in text (Amazon format)
          const orderIdPatterns = [
            /order[#\s]*([0-9-]{10,})/i,
            /transaction[#\s]*([0-9-]{10,})/i,
            /([0-9]{3}-[0-9]{7}-[0-9]{7})/,           // Standard Amazon order format
            /(D[A-Z0-9-]{10,})/,                      // Amazon order numbers starting with D
            /([A-Z][0-9]{2}-[0-9]{7}-[0-9]{7})/,     // Alternative Amazon format
            /([A-Z0-9]{10,})/                         // General alphanumeric codes
          ];
          
          for (const pattern of orderIdPatterns) {
            const match = elementText.match(pattern);
            if (match) {
              orderId = match[1];
              console.log(`Found order ID from text pattern: ${orderId}`);
              break;
            }
          }
          
          // Look for date patterns (Amazon uses various formats)
          const datePatterns = [
            /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}/i,  // "July 2, 2024"
            /(\d{1,2}\/\d{1,2}\/\d{4})/,                                                  // "7/2/2024"
            /(\d{4}-\d{2}-\d{2})/,                                                        // "2024-07-02"
            /(Jun|June) \d{1,2}, \d{4}/i,                                                // June 18, 2024
            /(Jul|July) \d{1,2}, \d{4}/i,                                                // July 2, 2024
          ];
          
          for (const pattern of datePatterns) {
            const match = elementText.match(pattern);
            if (match) {
              date = match[0];
              console.log(`Found date from text pattern: ${date}`);
              break;
            }
          }
          
          // Look for price patterns
          const pricePatterns = [
            /\$(\d+(?:,\d{3})*(?:\.\d{2})?)/,
            /(\d+\.\d{2})/
          ];
          
          for (const pattern of pricePatterns) {
            const match = elementText.match(pattern);
            if (match) {
              const priceText = match[1].replace(',', '');
              total = parseFloat(priceText);
              console.log(`Found price from text pattern: $${total}`);
              break;
            }
          }
        }
      }
      
      // Return transaction data if we found at least some information
      if (orderId || date || total > 0) {
        console.log(`✅ Extracted transaction data: ID=${orderId}, Date=${date}, Total=$${total}`);
        return {
          orderId: orderId || `unknown-${Date.now()}`,
          date: date || '',
          total: total || 0,
          orderDetailsUrl: orderDetailsUrl || ''
        };
      }
      
      console.log('❌ No transaction data found in element');
      return null;
      
    } catch (error) {
      console.error('Error extracting transaction data:', error);
      return null;
    }
  }

  async scrapeOrderDetails(transaction: BasicTransaction): Promise<Transaction> {
    const page = this.auth.getPage();
    if (!page) {
      throw new Error('Browser page not initialized');
    }
    
    try {
      console.log(`  📄 Scraping details for order ${transaction.orderId}`);
      
      // Navigate to order details page
      if (transaction.orderDetailsUrl) {
        await page.goto(transaction.orderDetailsUrl);
        await page.waitForLoadState('networkidle');
      }
      
      // Take screenshot of order page
      const screenshotPath = path.join(
        config.get('output.screenshotsDir'), 
        `order-${transaction.orderId}-${++this.screenshotCounter}.png`
      );
      await this.auth.takeScreenshot(screenshotPath);
      
      // Extract detailed order information including date
      const orderDetails = await this.extractOrderDetails(page);
      
      // Extract date from order page if not already present
      let orderDate = transaction.date;
      if (!orderDate) {
        const bodyText = await page.textContent('body') || '';
        const datePatterns = [
          /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4})/i,
          /(\d{1,2}\/\d{1,2}\/\d{4})/,
          /(\d{4}-\d{2}-\d{2})/
        ];
        
        for (const pattern of datePatterns) {
          const match = bodyText.match(pattern);
          if (match) {
            orderDate = match[1];
            console.log(`📅 Extracted date from order page: ${orderDate}`);
            break;
          }
        }
      }
      
      // Create detailed transaction object
      const detailedTransaction = createTransaction({
        orderId: transaction.orderId,
        date: orderDate || transaction.date,
        total: transaction.total,
        orderScreenshot: screenshotPath,
        ...orderDetails
      });
      
      return detailedTransaction;
      
    } catch (error) {
      console.error(`Error scraping order details for ${transaction.orderId}:`, error);
      
      // Return basic transaction data if detailed scraping fails
      return createTransaction({
        orderId: transaction.orderId,
        date: transaction.date,
        total: transaction.total,
        orderScreenshot: '',
        items: []
      });
    }
  }

  async extractOrderDetails(page: Page): Promise<OrderDetails> {
    const orderDetails: OrderDetails = {
      status: '',
      recipient: '',
      address: {},
      items: [],
      paymentMethod: '',
      trackingNumber: ''
    };
    
    try {
      // Extract order status
      const statusElement = await page.$('.order-status, .delivery-status, [data-testid="order-status"]');
      if (statusElement) {
        const statusText = await statusElement.textContent();
        if (statusText) {
          orderDetails.status = statusText.trim();
        }
      }
      
      // Extract recipient and address
      const addressElement = await page.$('.shipping-address, .delivery-address');
      if (addressElement) {
        const addressText = await addressElement.textContent();
        if (addressText) {
          orderDetails.recipient = addressText.split('\n')[0].trim();
          orderDetails.address = { full: addressText.trim() };
        }
      }
      
      // Extract payment method
      const paymentElement = await page.$('.payment-method, .payment-info');
      if (paymentElement) {
        const paymentText = await paymentElement.textContent();
        if (paymentText) {
          orderDetails.paymentMethod = paymentText.trim();
        }
      }
      
      // Extract items
      const itemElements = await page.$$('.order-item, .item-row, [data-testid="order-item"]');
      
      for (const itemElement of itemElements) {
        try {
          const item = await this.extractItemDetails(itemElement);
          if (item) {
            orderDetails.items.push(item);
          }
        } catch (error) {
          console.error('Error extracting item details:', error);
        }
      }
      
    } catch (error) {
      console.error('Error extracting order details:', error);
    }
    
    return orderDetails;
  }

  async extractItemDetails(itemElement: ElementHandle): Promise<Item | null> {
    try {
      const nameElement = await itemElement.$('.product-title, .item-title, a[href*="/dp/"]');
      const priceElement = await itemElement.$('.price, .item-price, .cost');
      const imageElement = await itemElement.$('img');
      
      let name = '';
      if (nameElement) {
        const nameText = await nameElement.textContent();
        if (nameText) {
          name = nameText.trim();
        }
      }
      
      let price = 0;
      if (priceElement) {
        const priceText = await priceElement.textContent();
        if (priceText) {
          const priceMatch = priceText.match(/\$?([\d,]+\.?\d*)/);
          if (priceMatch) {
            price = parseFloat(priceMatch[1].replace(',', ''));
          }
        }
      }
      
      let imageUrl = '';
      if (imageElement) {
        const src = await imageElement.getAttribute('src');
        if (src) {
          imageUrl = src;
        }
      }
      
      return createItem({
        name,
        price,
        quantity: 1,
        imageUrl,
        productUrl: ''
      });
      
    } catch (error) {
      console.error('Error extracting item details:', error);
      return null;
    }
  }

  async saveData(filename: string): Promise<string> {
    const filePath = path.join(config.get('output.dataDir'), filename);
    await fs.writeJSON(filePath, this.transactionData, { spaces: 2 });
    console.log(`💾 Data saved to ${filePath}`);
    return filePath;
  }

  async close(): Promise<void> {
    await this.auth.close();
  }
}

export default AmazonScraper;