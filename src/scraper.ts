import * as fs from 'fs-extra';
import * as path from 'path';
import { format, subDays, parseISO } from 'date-fns';
import AmazonAuth from './auth';
import config from './config';
import { createEmptyTransactionData, createTransaction, createItem } from './schemas';
import { TransactionData, Transaction, BasicTransaction, OrderDetails, Item } from './types';
import { Page, ElementHandle, Browser, BrowserContext } from 'playwright';
import { chromium } from 'playwright';

class AmazonScraper {
  private auth: AmazonAuth;
  private transactionData: TransactionData;
  private screenshotCounter: number = 0;
  private processedOrders: Set<string> = new Set();

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
    
    // Load previously processed orders
    await this.loadProcessedOrders();
  }

  async loadProcessedOrders(): Promise<void> {
    try {
      console.log('🔍 Loading previously processed orders...');
      
      // Check existing JSON files for processed orders
      const dataDir = config.get('output.dataDir');
      
      // Ensure the data directory exists
      await fs.ensureDir(dataDir);
      
      const files = await fs.readdir(dataDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(dataDir, file);
          const data = await fs.readJSON(filePath) as TransactionData;
          
          for (const transaction of data.transactions) {
            if (transaction.orderId) {
              this.processedOrders.add(transaction.orderId);
            }
          }
        } catch (error) {
          console.log(`⚠️ Could not read ${file}:`, error instanceof Error ? error.message : String(error));
        }
      }
      
      // Also check for existing screenshots
      const screenshotsDir = config.get('output.screenshotsDir');
      try {
        const screenshots = await fs.readdir(screenshotsDir);
        const orderScreenshots = screenshots.filter(f => f.startsWith('order-') && f.endsWith('.png'));
        
        for (const screenshot of orderScreenshots) {
          // Extract order ID from filename: order-D01-1234567-1234567-1.png
          const match = screenshot.match(/order-([^-]+-\d+-\d+)/);
          if (match) {
            this.processedOrders.add(match[1]);
          }
        }
      } catch (error) {
        // Screenshots directory might not exist yet
      }
      
      console.log(`✅ Found ${this.processedOrders.size} previously processed orders`);
      if (this.processedOrders.size > 0) {
        console.log('📋 Sample processed orders:', Array.from(this.processedOrders).slice(0, 3));
      }
      
    } catch (error) {
      console.log('⚠️ Could not load processed orders:', error instanceof Error ? error.message : String(error));
    }
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
      
      // Filter out already processed transactions
      const newTransactions = transactions.filter(t => {
        const isProcessed = this.processedOrders.has(t.orderId);
        if (isProcessed) {
          console.log(`⏭️ Skipping already processed order: ${t.orderId}`);
        }
        return !isProcessed;
      });
      
      console.log(`🔄 Processing ${newTransactions.length} new transactions (${transactions.length - newTransactions.length} already processed)`);
      
      if (newTransactions.length === 0) {
        console.log('✅ All transactions already processed!');
      } else {
        // Use parallel processing for order details
        await this.processTransactionsInParallel(newTransactions);
      }
      
      // Update metadata
      this.transactionData.metadata.totalTransactions = this.transactionData.transactions.length;
      this.transactionData.metadata.totalAmount = this.transactionData.transactions.reduce(
        (sum, t) => sum + (t.total || 0) - (t.refund || 0), 0
      );
      this.transactionData.metadata.scrapedAt = new Date().toISOString();
      
      const totalRefunds = this.transactionData.transactions.reduce(
        (sum, t) => sum + (t.refund || 0), 0
      );
      
      console.log(`✅ Scraped ${this.transactionData.transactions.length} transactions`);
      console.log(`💰 Total charged: $${this.transactionData.transactions.reduce((sum, t) => sum + (t.total || 0), 0).toFixed(2)}`);
      console.log(`💚 Total refunds: $${totalRefunds.toFixed(2)}`);
      console.log(`💰 Net amount: $${this.transactionData.metadata.totalAmount.toFixed(2)}`);
      
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
        const orderIdMatch = rowText.match(/(D\d{2}-\d{7}-\d{7}|1\d{2}-\d{7}-\d{7})/);
        if (orderIdMatch) {
          orderId = orderIdMatch[1];
          orderDetailsUrl = `https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}`;
        }
      }

      // If we have an order ID but no URL, construct the URL
      if (orderId && !orderDetailsUrl) {
        orderDetailsUrl = `https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}`;
      }
      
      if (orderId || total > 0) {
        const result = {
          orderId: orderId || `unknown-${Date.now()}`,
          date: '', // Will be filled from order page
          total,
          orderDetailsUrl
        };
        console.log(`🔗 Basic transaction URL: ${orderDetailsUrl}`);
        return result;
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
            /(1\d{2}-\d{7}-\d{7})/,                  // Standard Amazon order format (113-xxx)
            /(D\d{2}-\d{7}-\d{7})/,                  // Amazon order numbers starting with D
            /([A-Z]\d{2}-\d{7}-\d{7})/,              // Alternative Amazon format  
            /order[#\s]*([0-9-]{15,})/i,             // Order references
            /transaction[#\s]*([0-9-]{15,})/i        // Transaction references
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
      
      // If we have an order ID but no URL, construct the URL
      if (orderId && !orderDetailsUrl) {
        orderDetailsUrl = `https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}`;
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
      console.log(`🔗 Creating detailed transaction with URL: ${transaction.orderDetailsUrl}`);
      const detailedTransaction = createTransaction({
        orderId: transaction.orderId,
        date: orderDate || transaction.date,
        total: transaction.total,
        orderScreenshot: screenshotPath,
        orderDetailsUrl: transaction.orderDetailsUrl,
        ...orderDetails
      });
      
      console.log(`🔗 Final transaction URL: ${detailedTransaction.orderDetailsUrl}`);
      return detailedTransaction;
      
    } catch (error) {
      console.error(`Error scraping order details for ${transaction.orderId}:`, error);
      
      // Return basic transaction data if detailed scraping fails
      return createTransaction({
        orderId: transaction.orderId,
        date: transaction.date,
        total: transaction.total,
        orderScreenshot: '',
        orderDetailsUrl: transaction.orderDetailsUrl,
        items: []
      });
    }
  }

  async extractOrderDetails(page: Page): Promise<OrderDetails> {
    const orderDetails: OrderDetails = {
      recipient: '',
      address: {},
      items: [],
      paymentMethod: '',
      trackingNumber: '',
      refund: 0.0
    };
    
    try {
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
      
      // Extract refund information - look specifically for "Refund Total"
      const refundTotalElements = await page.$$('span, div, td');
      for (const element of refundTotalElements) {
        const text = await element.textContent();
        if (text && text.trim() === 'Refund Total') {
          console.log(`🔍 Found "Refund Total" text element`);
          
          // Look for the refund amount near this element
          const parent = await element.evaluateHandle(el => el.parentElement);
          if (parent) {
            const parentText = await parent.textContent();
            if (parentText) {
              const refundMatch = parentText.match(/\$([,\d]+\.?\d*)/);
              if (refundMatch) {
                orderDetails.refund = parseFloat(refundMatch[1].replace(',', ''));
                console.log(`📈 Found refund amount from "Refund Total": $${orderDetails.refund}`);
                break;
              }
            }
          }
          
          // Also check siblings
          const siblings = await element.evaluateHandle(el => el.parentElement?.children);
          if (siblings) {
            const siblingTexts = await siblings.evaluate(children => {
              const elements = Array.from(children as any);
              return elements.map((child: any) => child.textContent || '').join(' ');
            });
            const refundMatch = siblingTexts.match(/\$([,\d]+\.?\d*)/);
            if (refundMatch) {
              orderDetails.refund = parseFloat(refundMatch[1].replace(',', ''));
              console.log(`📈 Found refund amount from siblings: $${orderDetails.refund}`);
              break;
            }
          }
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

  async processTransactionsInParallel(transactions: BasicTransaction[]): Promise<void> {
    const PARALLEL_BROWSERS = 4;
    const browsers: Browser[] = [];
    const contexts: BrowserContext[] = [];
    
    try {
      console.log(`🚀 Starting ${PARALLEL_BROWSERS} browser instances for parallel processing...`);
      
      // Create multiple browser instances
      for (let i = 0; i < PARALLEL_BROWSERS; i++) {
        const browser = await chromium.launch({
          headless: config.get('scraping.headless'),
          slowMo: 100
        });
        browsers.push(browser);
        
        const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        contexts.push(context);
        
        // Copy cookies from main session to each browser
        const mainPage = this.auth.getPage();
        if (mainPage) {
          const cookies = await mainPage.context().cookies();
          await context.addCookies(cookies);
        }
      }
      
      // Divide transactions among browsers
      const chunks = this.chunkArray(transactions, PARALLEL_BROWSERS);
      console.log(`📦 Divided ${transactions.length} transactions into ${chunks.length} chunks`);
      
      // Process chunks in parallel
      const promises = chunks.map(async (chunk, index) => {
        if (chunk.length === 0) return [];
        
        const context = contexts[index];
        const page = await context.newPage();
        
        console.log(`🏭 Browser ${index + 1}: Processing ${chunk.length} transactions`);
        const results: Transaction[] = [];
        
        for (let i = 0; i < chunk.length; i++) {
          const transaction = chunk[i];
          try {
            console.log(`🏭 Browser ${index + 1}: Processing ${i + 1}/${chunk.length} - ${transaction.orderId}`);
            const detailedTransaction = await this.scrapeOrderDetailsWithPage(transaction, page, index + 1);
            results.push(detailedTransaction);
            
            // Mark as processed
            this.processedOrders.add(transaction.orderId);
            
            // Small delay between requests
            await page.waitForTimeout(1000);
            
          } catch (error) {
            console.error(`❌ Browser ${index + 1} error processing ${transaction.orderId}:`, error);
            // Add basic transaction data as fallback
            results.push(createTransaction(transaction));
          }
        }
        
        return results;
      });
      
      // Wait for all parallel processing to complete
      const allResults = await Promise.all(promises);
      
      // Combine results
      for (const results of allResults) {
        this.transactionData.transactions.push(...results);
      }
      
      console.log(`✅ Parallel processing complete! Processed ${transactions.length} transactions using ${PARALLEL_BROWSERS} browsers`);
      
    } finally {
      // Clean up browsers
      console.log('🧹 Cleaning up browser instances...');
      for (const browser of browsers) {
        try {
          await browser.close();
        } catch (error) {
          console.error('Error closing browser:', error);
        }
      }
    }
  }

  private chunkArray<T>(array: T[], chunks: number): T[][] {
    const result: T[][] = [];
    const chunkSize = Math.ceil(array.length / chunks);
    
    for (let i = 0; i < array.length; i += chunkSize) {
      result.push(array.slice(i, i + chunkSize));
    }
    
    // Ensure we have exactly the requested number of chunks (some may be empty)
    while (result.length < chunks) {
      result.push([]);
    }
    
    return result;
  }

  async scrapeOrderDetailsWithPage(transaction: BasicTransaction, page: Page, browserIndex: number): Promise<Transaction> {
    try {
      console.log(`  🏭 Browser ${browserIndex}: Scraping details for order ${transaction.orderId}`);
      
      // Navigate to order details page
      if (transaction.orderDetailsUrl) {
        await page.goto(transaction.orderDetailsUrl);
        await page.waitForLoadState('networkidle');
      }
      
      // Take screenshot of order page (idempotent filename)
      const screenshotPath = path.join(
        config.get('output.screenshotsDir'), 
        `order-${transaction.orderId}.png`
      );
      
      // Only take screenshot if it doesn't already exist
      if (!await fs.pathExists(screenshotPath)) {
        await this.takeSmartOrderScreenshot(page, screenshotPath);
        console.log(`  📸 Browser ${browserIndex}: Screenshot saved: ${screenshotPath}`);
      } else {
        console.log(`  📸 Browser ${browserIndex}: Screenshot already exists: ${screenshotPath}`);
      }
      
      // Extract detailed order information including date
      const orderDetails = await this.extractOrderDetailsWithPage(page);
      
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
            console.log(`  📅 Browser ${browserIndex}: Extracted date from order page: ${orderDate}`);
            break;
          }
        }
      }
      
      // Create detailed transaction object
      console.log(`🔗 Creating detailed transaction with URL: ${transaction.orderDetailsUrl}`);
      const detailedTransaction = createTransaction({
        orderId: transaction.orderId,
        date: orderDate || transaction.date,
        total: transaction.total,
        orderScreenshot: screenshotPath,
        orderDetailsUrl: transaction.orderDetailsUrl,
        ...orderDetails
      });
      
      console.log(`🔗 Final transaction URL: ${detailedTransaction.orderDetailsUrl}`);
      return detailedTransaction;
      
    } catch (error) {
      console.error(`❌ Browser ${browserIndex} error scraping order details for ${transaction.orderId}:`, error);
      
      // Return basic transaction data if detailed scraping fails
      return createTransaction({
        orderId: transaction.orderId,
        date: transaction.date,
        total: transaction.total,
        orderScreenshot: '',
        orderDetailsUrl: transaction.orderDetailsUrl,
        items: []
      });
    }
  }

  async extractOrderDetailsWithPage(page: Page): Promise<OrderDetails> {
    const orderDetails: OrderDetails = {
      recipient: '',
      address: {},
      items: [],
      paymentMethod: '',
      trackingNumber: '',
      refund: 0.0
    };
    
    try {
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
      
      // Extract refund information - look specifically for "Refund Total"
      const refundTotalElements = await page.$$('span, div, td');
      for (const element of refundTotalElements) {
        const text = await element.textContent();
        if (text && text.trim() === 'Refund Total') {
          console.log(`🔍 Found "Refund Total" text element`);
          
          // Look for the refund amount near this element
          const parent = await element.evaluateHandle(el => el.parentElement);
          if (parent) {
            const parentText = await parent.textContent();
            if (parentText) {
              const refundMatch = parentText.match(/\$([,\d]+\.?\d*)/);
              if (refundMatch) {
                orderDetails.refund = parseFloat(refundMatch[1].replace(',', ''));
                console.log(`📈 Found refund amount from "Refund Total": $${orderDetails.refund}`);
                break;
              }
            }
          }
          
          // Also check siblings
          const siblings = await element.evaluateHandle(el => el.parentElement?.children);
          if (siblings) {
            const siblingTexts = await siblings.evaluate(children => {
              const elements = Array.from(children as any);
              return elements.map((child: any) => child.textContent || '').join(' ');
            });
            const refundMatch = siblingTexts.match(/\$([,\d]+\.?\d*)/);
            if (refundMatch) {
              orderDetails.refund = parseFloat(refundMatch[1].replace(',', ''));
              console.log(`📈 Found refund amount from siblings: $${orderDetails.refund}`);
              break;
            }
          }
        }
      }

      // Extract items
      const itemElements = await page.$$('.order-item, .item-row, [data-testid="order-item"]');
      
      for (const itemElement of itemElements) {
        try {
          const item = await this.extractItemDetailsWithElement(itemElement);
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

  async extractItemDetailsWithElement(itemElement: ElementHandle): Promise<Item | null> {
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
        seller: '',
        imageUrl,
        productUrl: ''
      });
      
    } catch (error) {
      console.error('Error extracting item details:', error);
      return null;
    }
  }

  async takeSmartOrderScreenshot(page: Page, screenshotPath: string): Promise<void> {
    try {
      // First, check for "Refund Total" elements and hover over them to show tooltips
      const refundTotalElements = await page.$$('span, div, td');
      let foundRefundTotal = false;
      
      for (const element of refundTotalElements) {
        const text = await element.textContent();
        if (text && text.trim() === 'Refund Total') {
          console.log(`  💡 Found "Refund Total" - hovering to capture tooltip`);
          foundRefundTotal = true;
          
          // Hover over the element to trigger any tooltips
          await element.hover();
          await page.waitForTimeout(1000); // Wait for tooltip to appear
          break;
        }
      }
      
      if (foundRefundTotal) {
        console.log(`  📸 Taking screenshot with refund tooltip visible`);
      }
      
      // Look for the main order content container
      const cardElement = await page.$('.a-cardui, .order-details, .order-info');
      
      if (cardElement) {
        // Check if the element extends beyond the current viewport
        const elementBox = await cardElement.boundingBox();
        const viewport = page.viewportSize();
        
        if (elementBox && viewport) {
          const elementBottom = elementBox.y + elementBox.height;
          const viewportBottom = viewport.height;
          
          // If element extends beyond viewport, scroll to show it completely
          if (elementBottom > viewportBottom) {
            console.log(`  📏 Element extends beyond viewport, scrolling to capture full content`);
            await cardElement.evaluate(element => element.scrollIntoView());
            await page.waitForTimeout(500); // Wait for scroll to complete
            
            // Re-hover over refund total after scrolling if it was found
            if (foundRefundTotal) {
              for (const element of refundTotalElements) {
                const text = await element.textContent();
                if (text && text.trim() === 'Refund Total') {
                  await element.hover();
                  await page.waitForTimeout(500);
                  break;
                }
              }
            }
          }
        }
        
        // Take screenshot of just the element
        await cardElement.screenshot({ path: screenshotPath });
      } else {
        console.log(`  📸 No .a-cardui element found, taking viewport screenshot`);
        // Fallback to viewport screenshot if no card element found
        await page.screenshot({ path: screenshotPath });
      }
    } catch (error) {
      console.error(`Error taking smart screenshot: ${error}`);
      // Fallback to basic screenshot
      await page.screenshot({ path: screenshotPath });
    }
  }

  async close(): Promise<void> {
    await this.auth.close();
  }
}

export default AmazonScraper;