#!/usr/bin/env node

import * as fs from 'fs-extra';
import * as path from 'path';
import * as readline from 'readline';
import { format } from 'date-fns';
import { execSync } from 'child_process';
import * as dotenv from 'dotenv';
import AmazonScraper from './scraper';
import HTMLGenerator from './generator';
import config from './config';

// Load environment variables from .env file
dotenv.config();

interface CommandLineArgs {
  email?: string;
  days?: number;
  outputName?: string;
  generateOnly?: string;
  help?: boolean;
}

/**
 * Resolve a 1Password secret reference using the op CLI
 * @param reference - The op:// reference string
 * @param account - The 1Password account to use (default: "my")
 * @returns The resolved secret value
 */
function resolve1PasswordSecret(reference: string, account: string = 'my'): string | null {
  if (!reference || !reference.startsWith('op://')) {
    return reference; // Not a 1Password reference, return as-is
  }

  try {
    console.log(`🔐 Resolving 1Password secret: ${reference.substring(0, 30)}...`);
    const result = execSync(`op read "${reference}" --account "${account}"`, { encoding: 'utf-8' }).trim();
    console.log(`✅ Secret resolved successfully`);
    return result;
  } catch (error) {
    console.error(`❌ Failed to resolve 1Password secret: ${reference}`);
    console.error(`   Make sure you're signed in to 1Password CLI (run: op signin --account ${account})`);
    return null;
  }
}

/**
 * Get credentials from environment variables or 1Password
 */
function getCredentials(): { email: string | null; password: string | null; otp: string | null; anthropicApiKey: string | null } {
  const account = process.env.OP_ACCOUNT || 'my';
  const emailRef = process.env.AMAZON_EMAIL || process.env.AMAZON_USERNAME;
  const passwordRef = process.env.AMAZON_PASSWORD;
  let otpRef = process.env.AMAZON_OTP;
  const anthropicKeyRef = process.env.ANTHROPIC_API_KEY;

  // Automatically append ?attribute=otp to OTP references if it's an op:// reference
  if (otpRef && otpRef.startsWith('op://') && !otpRef.includes('?attribute=otp')) {
    otpRef = otpRef + '?attribute=otp';
  }

  return {
    email: emailRef ? resolve1PasswordSecret(emailRef, account) : null,
    password: passwordRef ? resolve1PasswordSecret(passwordRef, account) : null,
    otp: otpRef ? resolve1PasswordSecret(otpRef, account) : null,
    anthropicApiKey: anthropicKeyRef ? resolve1PasswordSecret(anthropicKeyRef, account) : null
  };
}

function parseArgs(): CommandLineArgs {
  const args: CommandLineArgs = {};
  const argv = process.argv.slice(2);
  
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    
    switch (arg) {
      case '-e':
      case '--email':
        args.email = argv[++i];
        break;
      case '-d':
      case '--days':
        args.days = parseInt(argv[++i], 10);
        break;
      case '-o':
      case '--output':
        args.outputName = argv[++i];
        break;
      case '-g':
      case '--generate':
        args.generateOnly = argv[++i];
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
    }
  }
  
  return args;
}

function showHelp(): void {
  console.log(`
Amazon Transaction Scraper

Usage:
  pnpm start -- [options]

Options:
  -e, --email <email>       Amazon account email
  -d, --days <number>       Number of days to scrape (default: 90)
  -o, --output <name>       Output file name prefix (default: transactions)
  -g, --generate <file>     Generate HTML from existing JSON file
  -h, --help                Show this help message

Examples:
  pnpm start -- -e user@example.com -d 30
  pnpm start -- --generate data/transactions-2024-07-05.json
  pnpm start -- -e user@example.com -o quarterly-report

Environment Variables (optional):
  Store credentials in .env file to avoid manual entry:

  OP_ACCOUNT           1Password account to use (default: "my")
  AMAZON_EMAIL         Email address (can use op:// reference)
  AMAZON_PASSWORD      Password (can use op:// reference)
  AMAZON_OTP           One-time password (can use op:// reference)
  ANTHROPIC_API_KEY    API key for AI summaries (can use op:// reference)

1Password CLI Integration:
  Use op:// references in .env to securely fetch credentials:

  OP_ACCOUNT=my
  AMAZON_EMAIL=op://vault/item-id/username
  AMAZON_PASSWORD=op://vault/item-id/password
  AMAZON_OTP=op://vault/item-id/one-time password
  ANTHROPIC_API_KEY=op://vault/item-id/api_key

  Copy .env.sample to .env and update with your 1Password references.
  Make sure you're signed in: op signin --account my
  Note: ?attribute=otp is automatically appended to OTP references.

AI Product Summaries:
  If ANTHROPIC_API_KEY is provided, Claude AI will generate intelligent
  product summaries. Without it, the scraper falls back to heuristic-based
  summaries. Get your API key from: https://console.anthropic.com/

Note: Password will be prompted securely if not provided via environment.
`);
}

async function promptPassword(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('Amazon Password: ', (password: string) => {
      rl.close();
      resolve(password);
    });

    // Only hide password input if we're in an interactive terminal
    if (process.stdin.isTTY && process.stdout.isTTY) {
      // Hide password input
      (rl as any).stdoutMuted = true;
      (rl as any)._writeToOutput = function(stringToWrite: string) {
        if ((rl as any).stdoutMuted && stringToWrite !== '\n' && stringToWrite !== '\r\n') {
          (rl as any).output.write('*');
        } else {
          (rl as any).output.write(stringToWrite);
        }
      };
    }
  });
}

async function promptOTP(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('OTP Code (if required, or press Enter to skip): ', (otp: string) => {
      rl.close();
      resolve(otp.trim());
    });
  });
}

async function main(): Promise<void> {
  try {
    const args = parseArgs();
    
    if (args.help) {
      showHelp();
      return;
    }
    
    if (args.generateOnly) {
      // Generate HTML from existing JSON file
      console.log('📄 Generating HTML from existing data...');
      
      const jsonPath = path.resolve(args.generateOnly);
      if (!fs.existsSync(jsonPath)) {
        console.error(`❌ JSON file not found: ${jsonPath}`);
        process.exit(1);
      }
      
      const generator = new HTMLGenerator();
      const outputName = args.outputName || 'transactions';
      const htmlPath = path.join(config.get('output.outputDir'), `${outputName}.html`);
      
      await generator.generateHTML(jsonPath, htmlPath);
      console.log(`✅ HTML report generated: ${htmlPath}`);
      return;
    }
    
    // Get credentials from environment/1Password
    const envCreds = getCredentials();

    // Use email from args or environment
    const email = args.email || envCreds.email;
    if (!email) {
      console.error('❌ Email is required for scraping');
      console.log('Provide via --email flag or AMAZON_EMAIL in .env file');
      console.log('Use --help for usage information');
      process.exit(1);
    }

    // Get password - from environment or prompt
    let password = envCreds.password;
    if (!password) {
      console.log('🔐 Enter your Amazon credentials:');
      password = await promptPassword();
      console.log(); // Add newline after password input
    } else {
      console.log('✅ Using password from environment/1Password');
    }

    // Get OTP - from environment or prompt
    let otpCode = envCreds.otp;
    if (!otpCode) {
      otpCode = await promptOTP();
      console.log(); // Add newline after OTP input
    } else {
      console.log('✅ Using OTP from environment/1Password');
    }

    if (!envCreds.anthropicApiKey) {
      console.error('❌ Missing ANTHROPIC_API_KEY. AI summarization is required.');
      process.exit(1);
    }

    const scraper = new AmazonScraper(envCreds.anthropicApiKey);

    try {
      console.log('🚀 Initializing Amazon scraper...');
      await scraper.initialize();

      console.log('🔐 Logging in to Amazon...');
      const loginSuccess = await scraper.login(email, password, otpCode);
      
      if (!loginSuccess) {
        console.error('❌ Login failed. Please check your credentials.');
        await scraper.close();
        process.exit(1);
      }
      
      console.log('📊 Scraping transactions...');
      const days = args.days || config.get('dateRange.defaultDays');
      const transactionData = await scraper.scrapeTransactions(days);
      
      // Save JSON data
      const timestamp = format(new Date(), 'yyyy-MM-dd-HH-mm');
      const outputName = args.outputName || 'transactions';
      const jsonFilename = `${outputName}-${timestamp}.json`;
      const jsonPath = await scraper.saveData(jsonFilename);
      
      console.log('📄 Generating HTML report...');
      const generator = new HTMLGenerator();
      const htmlPath = path.join(config.get('output.outputDir'), `${outputName}-${timestamp}.html`);
      await generator.generateHTML(jsonPath, htmlPath);
      
      console.log(`✅ Scraping complete!`);
      console.log(`📁 JSON data: ${jsonPath}`);
      console.log(`🌐 HTML report: ${htmlPath}`);
      console.log(`📊 Total transactions: ${transactionData.metadata.totalTransactions}`);
      console.log(`💰 Total amount: $${transactionData.metadata.totalAmount.toFixed(2)}`);

      // Print YNAB MCP prompts with JSON file path substituted
      const promptsPath = path.join(__dirname, '..', 'ynab-mcp-PROMPTS.md');
      if (fs.existsSync(promptsPath)) {
        const promptsContent = fs.readFileSync(promptsPath, 'utf-8');
        const promptsWithPath = promptsContent.replace(/\{\{json_file\}\}/g, path.resolve(jsonPath));
        console.log('\n' + '='.repeat(60));
        console.log('📋 Next Steps - YNAB Integration:');
        console.log('='.repeat(60));
        console.log('\nCopy and paste the following prompt into Claude Desktop to');
        console.log('correlate your Amazon transactions with YNAB:\n');
        console.log('-'.repeat(60) + '\n');
        console.log(promptsWithPath);
      }
      
    } finally {
      await scraper.close();
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

if (require.main === module) {
  main();
}

export default main;