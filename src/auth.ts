import { chromium, Browser, BrowserContext, Page } from 'playwright';
import config from './config';

class AmazonAuth {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private context: BrowserContext | null = null;

  constructor() {
    // Properties initialized above
  }

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: config.get('scraping.headless'),
      slowMo: 100
    });
    
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    this.page = await this.context.newPage();
    
    // Set extra headers to appear more like a real browser
    await this.page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
      'Sec-Fetch-Dest': 'document'
    });
  }

  async login(email: string, password: string): Promise<boolean> {
    if (!this.page) {
      throw new Error('Page not initialized. Call init() first.');
    }

    try {
      console.log('Navigating to Amazon payments page...');
      await this.page.goto(config.get('amazon.paymentsUrl'));
      
      // Wait for page to load and check if we need to authenticate
      await this.page.waitForTimeout(3000);
      
      const currentUrl = this.page.url();
      console.log(`Current URL: ${currentUrl}`);
      
      // Check if we're redirected to sign-in or if there's an auth form on the page
      const emailInput = await this.page.$('#ap_email');
      const emailInputAlt = await this.page.$('input[name="email"]');
      const usernameInput = await this.page.$('input[type="email"]');
      
      if (emailInput || emailInputAlt || usernameInput) {
        console.log('🔐 Authentication required. Filling out login form...');
        
        // Try different email input selectors
        let emailField = emailInput || emailInputAlt || usernameInput;
        if (emailField) {
          console.log('Entering email...');
          await emailField.fill(email);
          
          // Look for continue button or check if password field is already visible
          const continueBtn = await this.page.$('#continue');
          if (continueBtn) {
            await continueBtn.click();
            await this.page.waitForTimeout(2000);
          }
        }
        
        // Wait for password field
        const passwordInput = await this.page.waitForSelector('#ap_password, input[name="password"], input[type="password"]', { timeout: 10000 });
        
        if (passwordInput) {
          console.log('Entering password...');
          await passwordInput.fill(password);
          
          // Look for submit button
          const submitBtn = await this.page.$('#signInSubmit, button[type="submit"], input[type="submit"]');
          if (submitBtn) {
            await submitBtn.click();
          }
        }
        
        // Wait longer for potential passkey/2FA authentication
        console.log('⏳ Waiting for authentication to complete...');
        await this.page.waitForTimeout(5000);
        
        const newUrl = this.page.url();
        console.log(`🔗 Current URL after login: ${newUrl}`);
        
        // Check for various authentication scenarios
        if (newUrl.includes('ap/mfa') || newUrl.includes('ap/cvf') || newUrl.includes('challenge') || newUrl.includes('signin') || newUrl.includes('/ax/claim')) {
          console.log('🔐 Additional authentication required (2FA/Passkey/Challenge).');
          console.log('⏳ Waiting up to 2 minutes for you to complete authentication...');
          console.log('💡 Use your passkey, complete 2FA, or solve any challenges in the browser.');
          
          // Wait up to 2 minutes for authentication completion
          const maxWaitTime = 120000; // 2 minutes
          const checkInterval = 2000;  // Check every 2 seconds
          let waitTime = 0;
          
          while (waitTime < maxWaitTime) {
            await this.page.waitForTimeout(checkInterval);
            waitTime += checkInterval;
            
            const currentUrl = this.page.url();
            console.log(`⏱️  Waiting... (${Math.round(waitTime/1000)}s/${Math.round(maxWaitTime/1000)}s) - Current URL: ${currentUrl.substring(0, 80)}...`);
            
            // Check if we've successfully navigated away from auth pages
            if (!currentUrl.includes('ap/mfa') && 
                !currentUrl.includes('ap/cvf') && 
                !currentUrl.includes('challenge') && 
                !currentUrl.includes('signin') &&
                !currentUrl.includes('/ax/claim')) {
              console.log('✅ Authentication appears to be complete!');
              break;
            }
            
            // Check if we're on the target payments page
            if (currentUrl.includes('yourpayments')) {
              console.log('🎉 Successfully reached payments page!');
              break;
            }
          }
          
          if (waitTime >= maxWaitTime) {
            console.log('⏰ Authentication timeout reached. Continuing with current state...');
          }
          
          // Wait a bit more for any final navigation
          await this.page.waitForTimeout(3000);
        }
      }
      
      // Check if we're successfully logged in by looking for payment-specific elements
      const isLoggedIn = await this.checkPaymentsPageAccess();
      
      if (isLoggedIn) {
        console.log('✅ Successfully accessed Amazon payments page');
        return true;
      } else {
        console.log('❌ Login failed or additional verification needed');
        return false;
      }
      
    } catch (error) {
      console.error('Login error:', error);
      return false;
    }
  }

  async checkLoginStatus(): Promise<boolean> {
    if (!this.page) {
      return false;
    }

    try {
      // Try to navigate to account page to verify login
      await this.page.goto(config.get('amazon.baseUrl') + '/gp/css/homepage.html');
      
      // Check for account-specific elements
      const accountElement = await this.page.$('#nav-link-accountList');
      if (accountElement) {
        const accountText = await accountElement.textContent();
        return accountText?.includes('Hello') || accountText?.includes('Account') || false;
      }
      
      return false;
    } catch (error) {
      console.error('Error checking login status:', error);
      return false;
    }
  }

  async checkPaymentsPageAccess(): Promise<boolean> {
    if (!this.page) {
      return false;
    }

    try {
      // Wait for the page to load
      await this.page.waitForLoadState('networkidle');
      
      // Check if we're on the payments page by looking for payment-specific elements
      const paymentsIndicators = [
        '.pmts-portal-root',
        '.pmts-transaction-row',
        '[data-testid="transaction-row"]',
        '.order-info',
        'h1:has-text("Your Payments")',
        'h1:has-text("Your Orders")',
        '.payments-portal'
      ];
      
      for (const selector of paymentsIndicators) {
        try {
          const element = await this.page.$(selector);
          if (element) {
            console.log(`Found payments page indicator: ${selector}`);
            return true;
          }
        } catch (error) {
          // Continue trying other selectors
        }
      }
      
      // Check for authentication forms (indicating we're not logged in)
      // But skip this check if we're on a passkey/claim page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/ax/claim')) {
        const authIndicators = [
          '#ap_email',
          'input[name="email"]',
          'input[type="email"]',
          '#signInSubmit'
        ];
        
        for (const selector of authIndicators) {
          const element = await this.page.$(selector);
          if (element) {
            console.log('Found authentication form, not logged in');
            return false;
          }
        }
      }
      
      // If no specific indicators found, check page title and URL
      const title = await this.page.title();
      const url = this.page.url();
      
      console.log(`Page title: ${title}`);
      console.log(`Current URL: ${url}`);
      
      // Check if we're on a payments-related page
      return url.includes('yourpayments') || 
             url.includes('your-account') || 
             title.toLowerCase().includes('payment') ||
             title.toLowerCase().includes('order');
      
    } catch (error) {
      console.error('Error checking payments page access:', error);
      return false;
    }
  }

  async navigateToTransactions(): Promise<boolean> {
    if (!this.page) {
      return false;
    }

    try {
      const currentUrl = this.page.url();
      
      // If we're already on the payments page, no need to navigate
      if (currentUrl.includes('yourpayments/transactions')) {
        console.log('Already on transactions page');
        await this.page.waitForLoadState('networkidle');
        return true;
      }
      
      console.log('Navigating to transactions page...');
      await this.page.goto(config.get('amazon.paymentsUrl'));
      await this.page.waitForLoadState('networkidle');
      return true;
    } catch (error) {
      console.error('Error navigating to transactions:', error);
      return false;
    }
  }

  async takeScreenshot(filename: string): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    try {
      await this.page.screenshot({ path: filename, fullPage: true });
      console.log(`Screenshot saved: ${filename}`);
    } catch (error) {
      console.error('Error taking screenshot:', error);
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
  }

  getPage(): Page | null {
    return this.page;
  }
}

export default AmazonAuth;