#!/usr/bin/env node

import * as fs from 'fs-extra';
import * as path from 'path';
import { execSync } from 'child_process';
import * as dotenv from 'dotenv';
import AISummarizer from './ai-summarizer';
import config from './config';
import { TransactionData } from './types';

// Load environment variables
dotenv.config();

interface CommandLineArgs {
  file?: string;
  help?: boolean;
}

/**
 * Resolve a 1Password secret reference using the op CLI
 */
function resolve1PasswordSecret(reference: string, account: string = 'my'): string | null {
  if (!reference || !reference.startsWith('op://')) {
    return reference;
  }

  try {
    console.log(`🔐 Resolving 1Password secret...`);
    const result = execSync(`op read "${reference}" --account "${account}"`, { encoding: 'utf-8' }).trim();
    return result;
  } catch (error) {
    console.error(`❌ Failed to resolve 1Password secret`);
    console.error(`   Make sure you're signed in to 1Password CLI (run: op signin --account ${account})`);
    return null;
  }
}

function parseArgs(): CommandLineArgs {
  const args: CommandLineArgs = {};
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '-f':
      case '--file':
        args.file = argv[++i];
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
Amazon Transaction Summary Regenerator

Regenerate AI-powered product summaries for existing transaction data.
This allows you to iterate on the AI prompt without re-scraping Amazon.

Usage:
  pnpm run regenerate -- [options]

Options:
  -f, --file <path>     Path to JSON file to regenerate (required)
  -h, --help            Show this help message

Examples:
  pnpm run regenerate -- -f output/data/transactions-2025-01-15.json
  pnpm run regenerate -- --file output/data/transactions-2025-01-15.json

Environment Variables:
  ANTHROPIC_API_KEY     API key for AI summaries (required, can use op:// reference)
  OP_ACCOUNT            1Password account to use (default: "my")

Note: This script requires ANTHROPIC_API_KEY to be set in your .env file.
      The original transaction data file will be backed up before modification.
`);
}

async function regenerateSummaries(jsonPath: string, aiSummarizer: AISummarizer): Promise<void> {
  // Read the transaction data
  console.log(`📂 Loading transaction data from: ${jsonPath}`);
  const data: TransactionData = await fs.readJSON(jsonPath);

  console.log(`📊 Found ${data.transactions.length} transactions to process`);

  // Create backup
  const backupPath = jsonPath.replace('.json', '.backup.json');
  await fs.copy(jsonPath, backupPath);
  console.log(`💾 Backup created: ${backupPath}`);

  let updatedCount = 0;
  let skippedCount = 0;

  // Process each transaction
  for (const transaction of data.transactions) {
    const orderId = transaction.orderId;

    // Check if we have a product summary file to read from
    const summaryFileName = transaction.productSummaryFile;
    if (!summaryFileName) {
      console.log(`⏭️  Skipping ${orderId}: No product summary file recorded`);
      skippedCount++;
      continue;
    }

    // productSummaryFile already contains the full path (e.g., "output/screenshots/order-XXX.txt")
    // So we resolve it from the project root
    const summaryPath = path.resolve(summaryFileName);

    if (!await fs.pathExists(summaryPath)) {
      console.log(`⚠️  Skipping ${orderId}: Summary file not found: ${summaryPath}`);
      skippedCount++;
      continue;
    }

    try {
      // Read the page text from the summary file
      const pageText = await fs.readFile(summaryPath, 'utf-8');

      // Generate new AI summary
      console.log(`🤖 Regenerating summary for order ${orderId}...`);
      const newMemo = await aiSummarizer.createMemo(pageText, orderId);

      // Update the transaction
      transaction.memo = newMemo;
      updatedCount++;
      console.log(`✅ Updated: ${newMemo}`);

    } catch (error) {
      console.error(`❌ Failed to regenerate summary for ${orderId}:`, error instanceof Error ? error.message : String(error));
      skippedCount++;
    }
  }

  // Save the updated data
  await fs.writeJSON(jsonPath, data, { spaces: 2 });
  console.log(`\n📝 Summary regeneration complete!`);
  console.log(`   Updated: ${updatedCount} transactions`);
  console.log(`   Skipped: ${skippedCount} transactions`);
  console.log(`   Backup: ${backupPath}`);
  console.log(`   Updated file: ${jsonPath}`);
}

async function main(): Promise<void> {
  try {
    const args = parseArgs();

    if (args.help) {
      showHelp();
      return;
    }

    if (!args.file) {
      console.error('❌ Error: --file parameter is required');
      console.log('Use --help for usage information');
      process.exit(1);
    }

    const jsonPath = path.resolve(args.file);

    if (!await fs.pathExists(jsonPath)) {
      console.error(`❌ Error: File not found: ${jsonPath}`);
      process.exit(1);
    }

    // Get API key from environment
    const account = process.env.OP_ACCOUNT || 'my';
    const anthropicKeyRef = process.env.ANTHROPIC_API_KEY;

    if (!anthropicKeyRef) {
      console.error('❌ Error: ANTHROPIC_API_KEY is required in .env file');
      console.log('Add ANTHROPIC_API_KEY to your .env file (can use op:// reference)');
      process.exit(1);
    }

    const anthropicApiKey = resolve1PasswordSecret(anthropicKeyRef, account);

    if (!anthropicApiKey) {
      console.error('❌ Error: Failed to resolve ANTHROPIC_API_KEY');
      process.exit(1);
    }

    // Create AI summarizer
    const aiSummarizer = new AISummarizer(anthropicApiKey);

    // Regenerate summaries
    await regenerateSummaries(jsonPath, aiSummarizer);

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export default main;
