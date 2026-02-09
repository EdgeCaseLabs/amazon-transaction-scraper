#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { format, parseISO, isValid } from "date-fns";
import { ScrapeOptions } from "./types";
import * as path from "path";
import * as dotenv from "dotenv";
import { execSync } from "child_process";

import AmazonScraper from "./scraper";
import config from "./config";

// Change to project directory (parent of dist/)
const projectDir = path.resolve(__dirname, "..");
process.chdir(projectDir);

// Load environment variables
dotenv.config();

// Redirect console.log to stderr so MCP protocol messages on stdout aren't corrupted
const originalConsoleLog = console.log;
console.log = (...args) => console.error(...args);

/**
 * Resolve a 1Password secret reference using the op CLI
 */
function resolve1PasswordSecret(reference: string, account: string = "my"): string | null {
  if (!reference || !reference.startsWith("op://")) {
    return reference;
  }
  try {
    console.log(`Resolving 1Password secret: ${reference.substring(0, 30)}...`);
    const result = execSync(`op read "${reference}" --account "${account}"`, {
      encoding: "utf-8",
    }).trim();
    return result;
  } catch (error) {
    console.error(`Failed to resolve 1Password secret: ${reference}`);
    return null;
  }
}

/**
 * Get credentials from environment variables or 1Password
 */
function getCredentials() {
  const account = process.env.OP_ACCOUNT || "my";
  const emailRef = process.env.AMAZON_EMAIL || process.env.AMAZON_USERNAME;
  const passwordRef = process.env.AMAZON_PASSWORD;
  let otpRef = process.env.AMAZON_OTP;
  const anthropicKeyRef = process.env.ANTHROPIC_API_KEY;

  if (otpRef && otpRef.startsWith("op://") && !otpRef.includes("?attribute=otp")) {
    otpRef = otpRef + "?attribute=otp";
  }

  return {
    email: emailRef ? resolve1PasswordSecret(emailRef, account) : null,
    password: passwordRef ? resolve1PasswordSecret(passwordRef, account) : null,
    otp: otpRef ? resolve1PasswordSecret(otpRef, account) : null,
    anthropicApiKey: anthropicKeyRef ? resolve1PasswordSecret(anthropicKeyRef, account) : null,
  };
}

// Create the MCP server
const server = new McpServer({
  name: "amazon-transaction-scraper",
  version: "1.0.0",
});

// Register the scrape tool
server.tool(
  "scrape_amazon_transactions",
  "Scrape Amazon transaction history. Opens a browser window for manual 2FA/passkey authentication, then scrapes transactions and saves to JSON. Returns the full path to the generated JSON file.",
  {
    days: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe("Number of days to go back when scraping transactions (1-100, default: 15). Ignored if startDate is provided."),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
      .optional()
      .describe("Start date in YYYY-MM-DD format. If provided, overrides 'days' parameter."),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
      .optional()
      .describe("End date in YYYY-MM-DD format. Defaults to today if startDate is provided."),
  },
  async ({ days, startDate, endDate }) => {
    try {
      // Build scrape options
      const scrapeOptions: ScrapeOptions = {};

      if (startDate) {
        const parsedStart = parseISO(startDate);
        if (!isValid(parsedStart)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Invalid start date: ${startDate}. Use YYYY-MM-DD format.` }],
          };
        }
        scrapeOptions.startDate = parsedStart;

        if (endDate) {
          const parsedEnd = parseISO(endDate);
          if (!isValid(parsedEnd)) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Invalid end date: ${endDate}. Use YYYY-MM-DD format.` }],
            };
          }
          if (parsedEnd < parsedStart) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `End date (${endDate}) cannot be before start date (${startDate}).` }],
            };
          }
          scrapeOptions.endDate = parsedEnd;
        }
        console.log(`Starting Amazon transaction scrape from ${startDate} to ${endDate || 'today'}...`);
      } else {
        scrapeOptions.days = days || 15;
        console.log(`Starting Amazon transaction scrape for last ${scrapeOptions.days} days...`);
      }

      // Get credentials
      const creds = getCredentials();
      if (!creds.email || !creds.password) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Missing credentials. Ensure AMAZON_EMAIL and AMAZON_PASSWORD are set in .env file (can use op:// references for 1Password).",
            },
          ],
        };
      }

      if (!creds.anthropicApiKey) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Missing ANTHROPIC_API_KEY. AI summarization is required.",
            },
          ],
        };
      }

      // Initialize scraper (skip deduplication - MCP always scrapes fresh)
      const scraper = new AmazonScraper(creds.anthropicApiKey, true);

      try {
        console.log("Initializing Amazon scraper...");
        await scraper.initialize();

        console.log("Logging in to Amazon (browser window will open for 2FA)...");
        const loginSuccess = await scraper.login(creds.email, creds.password, creds.otp || undefined);

        if (!loginSuccess) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Login failed. Please check your credentials or complete 2FA in the browser window.",
              },
            ],
          };
        }

        console.log("Scraping transactions...");
        await scraper.scrapeTransactions(scrapeOptions);

        // Save JSON data
        const timestamp = format(new Date(), "yyyy-MM-dd-HH-mm");
        const jsonFilename = `transactions-${timestamp}.json`;
        const jsonPath = await scraper.saveData(jsonFilename);
        const fullPath = path.resolve(jsonPath);

        console.log(`Scraping complete! JSON saved to: ${fullPath}`);

        return {
          content: [
            {
              type: "text" as const,
              text: fullPath,
            },
          ],
        };
      } finally {
        await scraper.close();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Error during scraping: ${errorMessage}`,
          },
        ],
      };
    }
  }
);

// Start the server
async function main() {
  // Validate required env vars exist at startup (don't resolve yet)
  const emailVar = process.env.AMAZON_EMAIL || process.env.AMAZON_USERNAME;
  const passwordVar = process.env.AMAZON_PASSWORD;
  const anthropicVar = process.env.ANTHROPIC_API_KEY;

  if (!emailVar || !passwordVar) {
    console.error("Missing credentials. Ensure AMAZON_EMAIL and AMAZON_PASSWORD are set in .env file (can use op:// references for 1Password).");
    process.exit(1);
  }
  if (!anthropicVar) {
    console.error("Missing ANTHROPIC_API_KEY. AI summarization is required.");
    process.exit(1);
  }

  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log("Amazon Transaction Scraper MCP Server started");
  } catch (error) {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  }
}

main();
