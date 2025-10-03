# Amazon Transaction Scraper

A TypeScript-based tool to scrape Amazon transaction data and generate human-readable HTML reports with product images and order screenshots.

## Features

- **Secure Authentication**: Handles Amazon login with 2FA support
- **1Password Integration**: Use `op://` references to securely fetch credentials
- **Transaction Scraping**: Extracts transaction data from Amazon's payments page
- **Order Details**: Scrapes individual order pages for detailed product information
- **Product Images**: Captures product images and order screenshots
- **Smart Refund Logic**: Compares "Refund Total" vs "Grand Total" to determine if an order is fully refunded
- **Direct Amazon Links**: Includes clickable links to view orders directly on Amazon
- **JSON Export**: Saves all data in structured JSON format
- **HTML Reports**: Generates beautiful, interactive HTML reports with color-coded charges
- **Date Filtering**: Specify custom date ranges (default: 90 days)
- **TypeScript**: Full type safety and modern development experience

## Installation

```bash
# Install dependencies
pnpm install

# Install Playwright browsers
pnpm exec playwright install
```

## Usage

### Scrape Transactions

```bash
# Basic usage (password will be prompted securely)
pnpm start -- -e your@email.com

# Custom date range (30 days)
pnpm start -- -e your@email.com -d 30

# Custom output name
pnpm start -- -e your@email.com -o quarterly-report
```

### Generate HTML from Existing JSON

```bash
pnpm start -- --generate output/data/transactions-2024-07-05.json
```

### Using 1Password CLI (Optional)

For secure credential management without manual entry:

1. **Setup 1Password CLI**:
   ```bash
   # Install 1Password CLI
   brew install 1password-cli

   # Sign in
   op signin
   ```

2. **Create .env file**:
   ```bash
   # Copy the sample
   cp .env.sample .env

   # Edit with your 1Password references
   nano .env
   ```

3. **Example .env with 1Password references**:
   ```bash
   OP_ACCOUNT=my
   AMAZON_EMAIL=op://vault/item-id/username
   AMAZON_PASSWORD=op://vault/item-id/password
   AMAZON_OTP=op://vault/item-id/one-time password
   ```

   Note: `?attribute=otp` is automatically appended to the OTP reference.

4. **Run without prompts**:
   ```bash
   pnpm start -- -d 15
   # Credentials are automatically fetched from 1Password!
   ```

### Command Line Options

- `-e, --email <email>`: Amazon account email
- `-d, --days <number>`: Number of days to scrape (default: 90)
- `-o, --output <name>`: Output file name prefix (default: transactions)
- `-g, --generate <file>`: Generate HTML from existing JSON file
- `-h, --help`: Show help message

**Note:** Password is prompted securely at runtime and will not appear in bash history.

## Development

### Build

```bash
pnpm run build
```

### Development Mode

```bash
pnpm run dev
```

## Output Structure

```
amazon-scraper/
├── output/
│   ├── data/           # JSON data files
│   ├── screenshots/    # Order screenshots  
│   └── *.html          # HTML reports
└── config.json         # Configuration file
```

## Configuration

The tool creates a `config.json` file with default settings:

```json
{
  "amazon": {
    "email": "",
    "baseUrl": "https://www.amazon.com",
    "paymentsUrl": "https://www.amazon.com/cpe/yourpayments/transactions",
    "orderUrlPattern": "https://www.amazon.com/gp/your-account/order-details"
  },
  "scraping": {
    "headless": false,
    "timeout": 30000,
    "delayBetweenRequests": 2000,
    "maxRetries": 3
  },
  "output": {
    "dataDir": "./output/data",
    "outputDir": "./output",
    "screenshotsDir": "./output/screenshots"
  },
  "dateRange": {
    "defaultDays": 90
  }
}
```

## Data Format

### JSON Structure

```json
{
  "metadata": {
    "dateRange": {
      "start": "2024-01-01",
      "end": "2024-03-31"
    },
    "totalTransactions": 25,
    "totalAmount": 1250.75,
    "generatedAt": "2024-07-05T10:30:00Z"
  },
  "transactions": [
    {
      "orderId": "123-456-789",
      "date": "2024-01-15",
      "total": 45.99,
      "refunds": [],
      "grandTotal": 45.99,
      "recipient": "John Doe",
      "orderDetailsUrl": "https://www.amazon.com/gp/your-account/order-details?orderID=123-456-789",
      "items": [
        {
          "name": "Product Name",
          "price": 45.99,
          "quantity": 1,
          "imageUrl": "path/to/image.jpg"
        }
      ],
      "orderScreenshot": "output/screenshots/order-123.png"
    }
  ]
}
```

## Important Notes

### Legal and Ethical Use

- This tool is for **personal use only**
- Use only with your own Amazon account
- Respect Amazon's terms of service
- Do not use for commercial purposes
- Be mindful of rate limiting to avoid account restrictions

### Security

- Never commit your credentials to version control
- Password is prompted securely and masked with asterisks
- Passwords do not appear in command history or process lists
- The tool runs with non-headless browser by default for security verification
- 2FA is fully supported

### Limitations

- Amazon's page structure may change, requiring selector updates
- Heavy usage may trigger anti-bot measures
- Some transactions may require manual verification
- Product images depend on Amazon's image availability

## Troubleshooting

### Common Issues

1. **Login fails**: Check credentials and 2FA settings
2. **No transactions found**: Verify date range and page structure
3. **Screenshots empty**: Check output directory permissions
4. **Build errors**: Ensure TypeScript dependencies are installed

### Debug Mode

Set `"headless": false` in config.json to see browser interaction.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is for educational and personal use only. Use responsibly and in accordance with Amazon's terms of service.