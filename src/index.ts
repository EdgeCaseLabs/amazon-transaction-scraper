#!/usr/bin/env node

import * as fs from 'fs-extra';
import * as path from 'path';
import * as readline from 'readline';
import { format } from 'date-fns';
import AmazonScraper from './scraper';
import HTMLGenerator from './generator';
import config from './config';

interface CommandLineArgs {
  email?: string;
  days?: number;
  outputName?: string;
  generateOnly?: string;
  help?: boolean;
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

Note: Password will be prompted securely and will not appear in bash history.
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
    
    // Scrape transactions
    if (!args.email) {
      console.error('❌ Email is required for scraping');
      console.log('Use --help for usage information');
      process.exit(1);
    }

    // Prompt for password securely
    console.log('🔐 Enter your Amazon credentials:');
    const password = await promptPassword();
    console.log(); // Add newline after password input
    
    const scraper = new AmazonScraper();
    
    try {
      console.log('🚀 Initializing Amazon scraper...');
      await scraper.initialize();
      
      console.log('🔐 Logging in to Amazon...');
      const loginSuccess = await scraper.login(args.email, password);
      
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