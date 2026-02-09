import * as fs from 'fs-extra';
import * as path from 'path';
import { format, subDays, parseISO } from 'date-fns';
import AmazonAuth from './auth';
import config from './config';
import { createEmptyTransactionData, createTransaction, createItem } from './schemas';
import { TransactionData, Transaction, BasicTransaction, OrderDetails, Item, ScrapeOptions } from './types';
import { Page, ElementHandle, Browser, BrowserContext } from 'playwright';
import { chromium } from 'playwright';
import AISummarizer from './ai-summarizer';

class AmazonScraper {
  private auth: AmazonAuth;
  private transactionData: TransactionData;
  private screenshotCounter: number = 0;
  private processedOrders: Set<string> = new Set();
  private aiSummarizer: AISummarizer;
  private skipDeduplication: boolean;

  constructor(anthropicApiKey: string, skipDeduplication: boolean = false) {
    this.auth = new AmazonAuth();
    this.transactionData = createEmptyTransactionData();
    this.aiSummarizer = new AISummarizer(anthropicApiKey);
    this.skipDeduplication = skipDeduplication;
  }

  async initialize(): Promise<void> {
    await this.auth.init();

    // Ensure output directories exist
    await fs.ensureDir(config.get('output.dataDir'));
    await fs.ensureDir(config.get('output.outputDir'));
    await fs.ensureDir(config.get('output.screenshotsDir'));

    // Load previously processed orders (unless skipping deduplication)
    if (!this.skipDeduplication) {
      await this.loadProcessedOrders();
    }
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

  async login(email: string, password: string, otpCode?: string): Promise<boolean> {
    return await this.auth.login(email, password, otpCode);
  }

  async scrapeTransactions(options: ScrapeOptions = { days: 90 }): Promise<TransactionData> {
    try {
      let startDate: Date;
      let endDate: Date;

      if (options.startDate) {
        // Use explicit date range
        startDate = options.startDate;
        endDate = options.endDate || new Date();
        console.log(`🔍 Scraping transactions from ${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')}...`);
      } else {
        // Use days back from today
        const daysBack = options.days || 90;
        endDate = new Date();
        startDate = subDays(endDate, daysBack);
        console.log(`🔍 Scraping transactions from the last ${daysBack} days...`);
      }
      
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
      const transactions = await this.scrapeTransactionList(startDate, endDate);

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
      
      // Consolidate duplicate orders
      this.consolidateTransactions();
      
      // Update metadata
      this.transactionData.metadata.totalTransactions = this.transactionData.transactions.length;
      this.transactionData.metadata.totalAmount = this.transactionData.transactions.reduce(
        (sum, t) => sum + (t.total || 0) - (t.refunds.reduce((rSum, r) => rSum + r, 0)), 0
      );
      this.transactionData.metadata.scrapedAt = new Date().toISOString();
      
      const totalRefunds = this.transactionData.transactions.reduce(
        (sum, t) => sum + t.refunds.reduce((rSum, r) => rSum + r, 0), 0
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

  async scrapeTransactionList(startDate: Date, endDate: Date): Promise<BasicTransaction[]> {
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
      console.log(`📅 Date range filter: ${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')}`);

      let allTransactions: BasicTransaction[] = [];
      let currentPage = 1;
      let consecutiveOldTransactions = 0;
      const OLD_TRANSACTION_THRESHOLD = 5; // Stop if we find 5 consecutive transactions outside date range

      // Process all pages of transactions
      while (true) {
        console.log(`📄 Processing page ${currentPage}...`);

        // Get all transaction containers and date containers
        // Amazon's structure: date container, then multiple transaction rows, then another date container, etc.
        const pageElements = await page.$$('.apx-transaction-date-container, .apx-transactions-line-item-component-container');
        console.log(`📋 Found ${pageElements.length} elements (dates + transactions) on page ${currentPage}`);

        if (pageElements.length === 0) {
          console.log('❌ No transaction elements found on this page');
          break;
        }

        let transactionsBeforeDateRange = 0;
        let currentDate = '';
        let transactionCount = 0;

        // Process elements in order - when we hit a date, update current date; when we hit a transaction, use that date
        for (let i = 0; i < pageElements.length; i++) {
          const element = pageElements[i];

          // Check if this is a date container
          const className = await element.getAttribute('class');

          if (className?.includes('apx-transaction-date-container')) {
            // This is a date header - extract and store the date
            const dateText = await element.textContent();
            if (dateText) {
              currentDate = dateText.trim();
              console.log(`📅 Found date header: ${currentDate}`);
            }
            continue;
          }

          // This is a transaction row
          transactionCount++;
          console.log(`Processing transaction ${transactionCount} on page ${currentPage}`);

          try {
            const transaction = await this.extractTransactionFromRow(element);

            if (transaction) {
              // Apply the current date from the date header
              if (currentDate && !transaction.date) {
                transaction.date = currentDate;
              }

              // Check if transaction is within date range
              let transactionDate: Date | null = null;
              if (transaction.date) {
                try {
                  transactionDate = parseISO(transaction.date);
                  // Handle various date formats
                  if (isNaN(transactionDate.getTime())) {
                    transactionDate = new Date(transaction.date);
                  }
                } catch (e) {
                  console.log(`⚠️ Could not parse date: ${transaction.date}`);
                }
              }

              // If we have a valid date, check if it's in range
              if (transactionDate && !isNaN(transactionDate.getTime())) {
                if (transactionDate < startDate) {
                  console.log(`📅 Transaction ${transaction.orderId} is before start date (${transaction.date}), skipping`);
                  transactionsBeforeDateRange++;
                  consecutiveOldTransactions++;

                  // Stop if we've found enough consecutive old transactions
                  if (consecutiveOldTransactions >= OLD_TRANSACTION_THRESHOLD) {
                    console.log(`⏹️ Found ${consecutiveOldTransactions} consecutive transactions before ${format(startDate, 'yyyy-MM-dd')}, stopping pagination`);
                    return allTransactions;
                  }
                  continue;
                } else if (transactionDate > endDate) {
                  console.log(`📅 Transaction ${transaction.orderId} is after end date (${transaction.date}), skipping`);
                  continue;
                } else {
                  // Transaction is in range, reset counter
                  consecutiveOldTransactions = 0;
                }
              } else {
                // No date found, include it but reset counter
                console.log(`⚠️ No date found for transaction ${transaction.orderId}, including anyway`);
                consecutiveOldTransactions = 0;
              }

              allTransactions.push(transaction);
              console.log(`✅ Extracted: ${transaction.orderId} - ${transaction.date} - $${transaction.total}`);
            }
          } catch (error) {
            console.error(`❌ Error processing transaction ${i + 1}:`, error);
          }
        }

        // If all transactions on this page were before the date range, stop
        if (transactionsBeforeDateRange === transactionCount && transactionCount > 0) {
          console.log(`⏹️ All ${transactionsBeforeDateRange} transactions on page ${currentPage} are before ${format(startDate, 'yyyy-MM-dd')}, stopping pagination`);
          break;
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

      // Date will be set from the date header container, not from the row
      let date = '';

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
          date: date,
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
      refunds: [],
      grandTotal: 0.0
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
      
      // Extract refund information - look for both "Refund Total" and "Grand Total"
      const totalElements = await page.$$('span, div, td');
      let grandTotal = 0;
      
      for (const element of totalElements) {
        const text = await element.textContent();
        
        // Check for Refund Total
        if (text && text.trim() === 'Refund Total') {
          console.log(`🔍 Found "Refund Total" text element`);
          
          // Look for the refund amount near this element
          const parent = await element.evaluateHandle(el => el.parentElement);
          if (parent) {
            const parentText = await parent.textContent();
            if (parentText) {
              const refundMatch = parentText.match(/\$([,\d]+\.?\d*)/);
              if (refundMatch) {
                const refundAmount = parseFloat(refundMatch[1].replace(',', ''));
                orderDetails.refunds.push(refundAmount);
                console.log(`📈 Found refund amount from "Refund Total": $${refundAmount}`);
              }
            }
          }
          
          // Also check siblings
          if (orderDetails.refunds.length === 0) {
            const siblings = await element.evaluateHandle(el => el.parentElement?.children);
            if (siblings) {
              const siblingTexts = await siblings.evaluate(children => {
                const elements = Array.from(children as any);
                return elements.map((child: any) => child.textContent || '').join(' ');
              });
              const refundMatch = siblingTexts.match(/\$([,\d]+\.?\d*)/);
              if (refundMatch) {
                const refundAmount = parseFloat(refundMatch[1].replace(',', ''));
                orderDetails.refunds.push(refundAmount);
                console.log(`📈 Found refund amount from siblings: $${refundAmount}`);
              }
            }
          }
        }
        
        // Check for Grand Total
        if (text && text.trim() === 'Grand Total') {
          console.log(`🔍 Found "Grand Total" text element`);
          
          // Look for the grand total amount near this element
          const parent = await element.evaluateHandle(el => el.parentElement);
          if (parent) {
            const parentText = await parent.textContent();
            if (parentText) {
              const grandTotalMatch = parentText.match(/\$([,\d]+\.?\d*)/);
              if (grandTotalMatch) {
                grandTotal = parseFloat(grandTotalMatch[1].replace(',', ''));
                console.log(`💰 Found grand total amount: $${grandTotal}`);
              }
            }
          }
          
          // Also check siblings for grand total
          if (grandTotal === 0) {
            const siblings = await element.evaluateHandle(el => el.parentElement?.children);
            if (siblings) {
              const siblingTexts = await siblings.evaluate(children => {
                const elements = Array.from(children as any);
                return elements.map((child: any) => child.textContent || '').join(' ');
              });
              const grandTotalMatch = siblingTexts.match(/\$([,\d]+\.?\d*)/);
              if (grandTotalMatch) {
                grandTotal = parseFloat(grandTotalMatch[1].replace(',', ''));
                console.log(`💰 Found grand total from siblings: $${grandTotal}`);
              }
            }
          }
        }
      }
      
      // Store the grand total in order details
      orderDetails.grandTotal = grandTotal;
      
      // Log the comparison for debugging
      const totalRefunds = orderDetails.refunds.reduce((sum, refund) => sum + refund, 0);
      if (totalRefunds > 0 && grandTotal > 0) {
        console.log(`🔍 Total Refunds: $${totalRefunds} vs Grand Total: $${grandTotal}`);
        console.log(`📋 Individual refunds: [${orderDetails.refunds.map(r => `$${r}`).join(', ')}]`);
        if (totalRefunds >= grandTotal) {
          console.log(`✅ Refunds cover grand total - will show as refunded`);
        } else {
          console.log(`❌ Refunds do not cover grand total - will show as charged`);
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
            throw error;
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

      // IMPORTANT: Extract rendered page text AFTER screenshot
      // This ensures we get the DOM content after JavaScript has executed and rendered
      // Extract from the same element we screenshot (.a-cardui) for consistency
      console.log(`  📄 Browser ${browserIndex}: Extracting rendered page content...`);
      const cardElement = await page.$('.a-cardui, .order-details, .order-info');

      let pageText = '';
      if (cardElement) {
        pageText = await cardElement.evaluate((element) => {
          // @ts-ignore - innerText is available in browser context
          return element.innerText || element.textContent || '';
        }) as string;
        console.log(`  📄 Browser ${browserIndex}: Extracted ${pageText.length} characters from .a-cardui element`);
      } else {
        // Fallback to full body if card element not found
        pageText = await page.evaluate(() => {
          // @ts-ignore - document is available in browser context
          return document.body.innerText || document.body.textContent || '';
        }) as string;
        console.log(`  📄 Browser ${browserIndex}: Extracted ${pageText.length} characters from full page (no .a-cardui found)`);
      }

      // Extract detailed order information including date
      const orderDetails = await this.extractOrderDetailsWithPage(page);

      // Extract date from order page if not already present
      let orderDate = transaction.date;
      if (!orderDate) {
        const datePatterns = [
          /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4})/i,
          /(\d{1,2}\/\d{1,2}\/\d{4})/,
          /(\d{4}-\d{2}-\d{2})/
        ];

        for (const pattern of datePatterns) {
          const match = pageText.match(pattern);
          if (match) {
            orderDate = match[1];
            console.log(`  📅 Browser ${browserIndex}: Extracted date from order page: ${orderDate}`);
            break;
          }
        }
      }

      // Generate product summary and memo
      let productSummaryFile = '';
      let memo = '';

      // Generate summary from rendered page text
      const summary = await this.generateProductSummaryFromPage(page, transaction.orderId, pageText);
      productSummaryFile = await this.saveProductSummaryToFile(transaction.orderId, summary);

      if (orderDetails.items && orderDetails.items.length > 0) {
        memo = this.createMemoFromItems(orderDetails.items, transaction.orderId);
        console.log(`  📝 Browser ${browserIndex}: Created memo from items: ${memo}`);
      } else {
        // Create memo from page text if no items were extracted
        memo = await this.createMemoFromPageText(pageText, transaction.orderId);
        console.log(`  📝 Browser ${browserIndex}: Created memo from page text: ${memo}`);
      }

      // Create detailed transaction object
      console.log(`🔗 Creating detailed transaction with URL: ${transaction.orderDetailsUrl}`);
      const detailedTransaction = createTransaction({
        orderId: transaction.orderId,
        date: orderDate || transaction.date,
        total: transaction.total,
        orderScreenshot: screenshotPath,
        orderDetailsUrl: transaction.orderDetailsUrl,
        memo,
        productSummaryFile,
        ...orderDetails
      });

      console.log(`🔗 Final transaction URL: ${detailedTransaction.orderDetailsUrl}`);
      return detailedTransaction;
      
    } catch (error) {
      console.error(`❌ Browser ${browserIndex} error scraping order details for ${transaction.orderId}:`, error);
      throw error;
    }
  }

  async extractOrderDetailsWithPage(page: Page): Promise<OrderDetails> {
    const orderDetails: OrderDetails = {
      recipient: '',
      address: {},
      items: [],
      paymentMethod: '',
      trackingNumber: '',
      refunds: [],
      grandTotal: 0.0
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
      
      // Extract refund information - look for both "Refund Total" and "Grand Total"
      const totalElements = await page.$$('span, div, td');
      let grandTotal = 0;
      
      for (const element of totalElements) {
        const text = await element.textContent();
        
        // Check for Refund Total
        if (text && text.trim() === 'Refund Total') {
          console.log(`🔍 Found "Refund Total" text element`);
          
          // Look for the refund amount near this element
          const parent = await element.evaluateHandle(el => el.parentElement);
          if (parent) {
            const parentText = await parent.textContent();
            if (parentText) {
              const refundMatch = parentText.match(/\$([,\d]+\.?\d*)/);
              if (refundMatch) {
                const refundAmount = parseFloat(refundMatch[1].replace(',', ''));
                orderDetails.refunds.push(refundAmount);
                console.log(`📈 Found refund amount from "Refund Total": $${refundAmount}`);
              }
            }
          }
          
          // Also check siblings
          if (orderDetails.refunds.length === 0) {
            const siblings = await element.evaluateHandle(el => el.parentElement?.children);
            if (siblings) {
              const siblingTexts = await siblings.evaluate(children => {
                const elements = Array.from(children as any);
                return elements.map((child: any) => child.textContent || '').join(' ');
              });
              const refundMatch = siblingTexts.match(/\$([,\d]+\.?\d*)/);
              if (refundMatch) {
                const refundAmount = parseFloat(refundMatch[1].replace(',', ''));
                orderDetails.refunds.push(refundAmount);
                console.log(`📈 Found refund amount from siblings: $${refundAmount}`);
              }
            }
          }
        }
        
        // Check for Grand Total
        if (text && text.trim() === 'Grand Total') {
          console.log(`🔍 Found "Grand Total" text element`);
          
          // Look for the grand total amount near this element
          const parent = await element.evaluateHandle(el => el.parentElement);
          if (parent) {
            const parentText = await parent.textContent();
            if (parentText) {
              const grandTotalMatch = parentText.match(/\$([,\d]+\.?\d*)/);
              if (grandTotalMatch) {
                grandTotal = parseFloat(grandTotalMatch[1].replace(',', ''));
                console.log(`💰 Found grand total amount: $${grandTotal}`);
              }
            }
          }
          
          // Also check siblings for grand total
          if (grandTotal === 0) {
            const siblings = await element.evaluateHandle(el => el.parentElement?.children);
            if (siblings) {
              const siblingTexts = await siblings.evaluate(children => {
                const elements = Array.from(children as any);
                return elements.map((child: any) => child.textContent || '').join(' ');
              });
              const grandTotalMatch = siblingTexts.match(/\$([,\d]+\.?\d*)/);
              if (grandTotalMatch) {
                grandTotal = parseFloat(grandTotalMatch[1].replace(',', ''));
                console.log(`💰 Found grand total from siblings: $${grandTotal}`);
              }
            }
          }
        }
      }
      
      // Store the grand total in order details
      orderDetails.grandTotal = grandTotal;
      
      // Log the comparison for debugging
      const totalRefunds = orderDetails.refunds.reduce((sum, refund) => sum + refund, 0);
      if (totalRefunds > 0 && grandTotal > 0) {
        console.log(`🔍 Total Refunds: $${totalRefunds} vs Grand Total: $${grandTotal}`);
        console.log(`📋 Individual refunds: [${orderDetails.refunds.map(r => `$${r}`).join(', ')}]`);
        if (totalRefunds >= grandTotal) {
          console.log(`✅ Refunds cover grand total - will show as refunded`);
        } else {
          console.log(`❌ Refunds do not cover grand total - will show as charged`);
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
      // First, check for "Refund Total" and "Grand Total" elements and hover over them to show tooltips
      const totalElements = await page.$$('span, div, td');
      let foundRefundTotal = false;
      let foundGrandTotal = false;
      
      for (const element of totalElements) {
        const text = await element.textContent();
        if (text && text.trim() === 'Refund Total') {
          console.log(`  💡 Found "Refund Total" - hovering to capture tooltip`);
          foundRefundTotal = true;
          
          // Hover over the element to trigger any tooltips
          await element.hover();
          await page.waitForTimeout(1000); // Wait for tooltip to appear
        }
        if (text && text.trim() === 'Grand Total') {
          console.log(`  💡 Found "Grand Total" - hovering to capture tooltip`);
          foundGrandTotal = true;
          
          // Hover over the element to trigger any tooltips
          await element.hover();
          await page.waitForTimeout(1000); // Wait for tooltip to appear
        }
      }
      
      if (foundRefundTotal || foundGrandTotal) {
        console.log(`  📸 Taking screenshot with total tooltips visible`);
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
            
            // Re-hover over totals after scrolling if they were found
            if (foundRefundTotal || foundGrandTotal) {
              for (const element of totalElements) {
                const text = await element.textContent();
                if (text && (text.trim() === 'Refund Total' || text.trim() === 'Grand Total')) {
                  await element.hover();
                  await page.waitForTimeout(500);
                }
              }
            }
          }
        }
        
        // Take screenshot of just the element
        await cardElement.screenshot({ path: screenshotPath });
      } else {
        console.log(`  📸 No .a-cardui element found, taking full page screenshot`);
        // Fallback to full page screenshot if no card element found
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }
    } catch (error) {
      console.error(`Error taking smart screenshot: ${error}`);
      // Fallback to full page screenshot
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
  }

  /**
   * Generate a detailed product summary from page content
   */
  async generateProductSummaryFromPage(page: Page, orderId: string, pageText: string): Promise<string> {
    const lines: string[] = [
      `Order: ${orderId}`,
      `Scraped: ${new Date().toISOString()}`,
      '',
      'Page Content:',
      '---',
      pageText.substring(0, 5000) // Limit to first 5000 chars
    ];

    return lines.join('\n');
  }

  /**
   * Create memo from page text using AI summarization
   */
  async createMemoFromPageText(pageText: string, orderId: string): Promise<string> {
    return await this.aiSummarizer.createMemo(pageText, orderId);
  }

  /**
   * Generate a detailed product summary from items
   */
  generateProductSummary(items: Item[], orderId: string): string {
    if (!items || items.length === 0) {
      return `Order ${orderId}: No product details available`;
    }

    const lines: string[] = [
      `Order: ${orderId}`,
      `Total Items: ${items.reduce((sum, item) => sum + item.quantity, 0)}`,
      '',
      'Products:'
    ];

    for (const item of items) {
      const quantityStr = item.quantity > 1 ? `${item.quantity}x ` : '';
      const priceStr = item.price > 0 ? ` - $${item.price.toFixed(2)}` : '';
      const sellerStr = item.seller ? ` (Sold by: ${item.seller})` : '';

      lines.push(`  ${quantityStr}${item.name}${priceStr}${sellerStr}`);
    }

    return lines.join('\n');
  }

  /**
   * Create a concise memo from items for quick reference
   */
  createMemoFromItems(items: Item[], orderId: string): string {
    if (!items || items.length === 0) {
      return `[${orderId}] - No products`;
    }

    const productSummaries = items.map(item => {
      const quantityStr = item.quantity > 1 ? `${item.quantity}x ` : '';
      return `${quantityStr}${item.name}`;
    });

    // Limit to first 3 products to keep memo concise
    const displayItems = productSummaries.slice(0, 3);
    const more = productSummaries.length > 3 ? `, +${productSummaries.length - 3} more` : '';

    return `[${orderId}] - ${displayItems.join(', ')}${more}`;
  }

  /**
   * Save product summary to a text file
   */
  async saveProductSummaryToFile(orderId: string, summary: string): Promise<string> {
    const summaryPath = path.join(
      config.get('output.screenshotsDir'),
      `order-${orderId}.txt`
    );

    // Only save if it doesn't already exist (idempotent)
    if (await fs.pathExists(summaryPath)) {
      console.log(`  📄 Summary file already exists: ${summaryPath}`);
      return summaryPath;
    }

    await fs.writeFile(summaryPath, summary, 'utf8');
    console.log(`  📄 Summary saved: ${summaryPath}`);

    return summaryPath;
  }

  consolidateTransactions(): void {
    console.log(`🔄 Consolidating duplicate transactions...`);
    const transactionMap = new Map<string, Transaction>();

    for (const transaction of this.transactionData.transactions) {
      const orderId = transaction.orderId;

      if (transactionMap.has(orderId)) {
        const existing = transactionMap.get(orderId)!;

        // Merge refunds from duplicate transactions
        existing.refunds.push(...transaction.refunds);

        // Keep the higher total (original purchase amount)
        if (transaction.total > existing.total) {
          existing.total = transaction.total;
        }

        // Keep the higher grand total
        if (transaction.grandTotal > existing.grandTotal) {
          existing.grandTotal = transaction.grandTotal;
        }

        // Merge other details if they're missing
        if (!existing.recipient && transaction.recipient) {
          existing.recipient = transaction.recipient;
        }
        if (!existing.address.full && transaction.address.full) {
          existing.address = transaction.address;
        }
        if (!existing.paymentMethod && transaction.paymentMethod) {
          existing.paymentMethod = transaction.paymentMethod;
        }
        if (transaction.items.length > existing.items.length) {
          existing.items = transaction.items;
        }
        if (!existing.orderScreenshot && transaction.orderScreenshot) {
          existing.orderScreenshot = transaction.orderScreenshot;
        }

        console.log(`🔗 Merged duplicate order ${orderId} - Refunds: [${existing.refunds.map(r => `$${r}`).join(', ')}]`);
      } else {
        transactionMap.set(orderId, { ...transaction });
      }
    }

    // Replace transactions with consolidated ones
    this.transactionData.transactions = Array.from(transactionMap.values());
    console.log(`✅ Consolidated to ${this.transactionData.transactions.length} unique transactions`);
  }

  async close(): Promise<void> {
    await this.auth.close();
  }
}

export default AmazonScraper;