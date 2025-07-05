import * as fs from 'fs-extra';
import * as path from 'path';
import { format, parseISO } from 'date-fns';
import config from './config';
import { TransactionData, Transaction, Item } from './types';

class HTMLGenerator {
  private templatePath: string;

  constructor() {
    this.templatePath = path.join(__dirname, 'templates');
  }

  async generateHTML(jsonFilePath: string, outputPath: string): Promise<string> {
    try {
      console.log('📄 Generating HTML report...');
      
      // Read the JSON data
      const data = await fs.readJSON(jsonFilePath);
      
      // Generate HTML content
      const htmlContent = this.createHTMLContent(data);
      
      // Write HTML file
      await fs.writeFile(outputPath, htmlContent);
      
      console.log(`✅ HTML report generated: ${outputPath}`);
      return outputPath;
      
    } catch (error) {
      console.error('Error generating HTML:', error);
      throw error;
    }
  }

  createHTMLContent(data: TransactionData): string {
    const { metadata, transactions } = data;
    
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Amazon Transactions Report</title>
    <style>
        ${this.getCSS()}
    </style>
</head>
<body>
    <div class="container">
        <header class="header">
            <h1>Amazon Transactions Report</h1>
            <div class="metadata">
                <div class="meta-item">
                    <span class="label">Date Range:</span>
                    <span class="value">${metadata.dateRange.start} to ${metadata.dateRange.end}</span>
                </div>
                <div class="meta-item">
                    <span class="label">Total Transactions:</span>
                    <span class="value">${metadata.totalTransactions}</span>
                </div>
                <div class="meta-item">
                    <span class="label">Total Amount:</span>
                    <span class="value total-amount">$${metadata.totalAmount.toFixed(2)}</span>
                </div>
                <div class="meta-item">
                    <span class="label">Generated:</span>
                    <span class="value">${new Date(metadata.generatedAt).toLocaleDateString()}</span>
                </div>
            </div>
        </header>

        <div class="controls">
            <button onclick="toggleAll(true)" class="btn">Expand All</button>
            <button onclick="toggleAll(false)" class="btn">Collapse All</button>
            <button onclick="window.print()" class="btn">Print</button>
        </div>

        <div class="transactions">
            ${transactions.map(transaction => this.createTransactionHTML(transaction)).join('')}
        </div>
    </div>

    <script>
        ${this.getJavaScript()}
    </script>
</body>
</html>`;
    
    return html;
  }

  createTransactionHTML(transaction: Transaction): string {
    const formattedDate = this.formatDate(transaction.date);
    const hasItems = transaction.items && transaction.items.length > 0;
    const hasRefund = transaction.refund > 0;
    const amountClass = hasRefund ? 'order-amount-refunded' : 'order-amount-charged';
    
    return `
        <div class="transaction" data-order-id="${transaction.orderId}">
            <div class="transaction-header" onclick="toggleTransaction('${transaction.orderId}')">
                <div class="transaction-main">
                    <div class="order-info">
                        <div class="order-id">${transaction.orderId}</div>
                        <div class="order-date">${formattedDate}</div>
                    </div>
                    <div class="order-amount-container">
                        <div class="order-amount ${amountClass}">$${transaction.total.toFixed(2)}</div>
                        ${hasRefund ? `<div class="refund-amount">Refund: $${transaction.refund.toFixed(2)}</div>` : ''}
                    </div>
                </div>
                <div class="expand-icon">▼</div>
            </div>
            
            <div class="transaction-details" id="details-${transaction.orderId}">
                ${transaction.orderDetailsUrl ? `
                    <div class="order-link">
                        <a href="${transaction.orderDetailsUrl}" target="_blank" rel="noopener noreferrer" class="amazon-link">
                            📦 View Order on Amazon
                        </a>
                    </div>
                ` : ''}
                ${transaction.recipient ? `<div class="recipient">Delivered to: ${transaction.recipient}</div>` : ''}
                ${transaction.address.full ? `<div class="address">${transaction.address.full}</div>` : ''}
                ${transaction.paymentMethod ? `<div class="payment-method">Payment: ${transaction.paymentMethod}</div>` : ''}
                ${transaction.trackingNumber ? `<div class="tracking">Tracking: ${transaction.trackingNumber}</div>` : ''}
                
                ${hasItems ? `
                    <div class="items">
                        <h4>Items:</h4>
                        <div class="items-grid">
                            ${transaction.items.map(item => this.createItemHTML(item)).join('')}
                        </div>
                    </div>
                ` : ''}
                
                ${transaction.orderScreenshot ? `
                    <div class="screenshot-section">
                        <h4>Order Screenshot:</h4>
                        <img src="${this.getRelativePath(transaction.orderScreenshot)}" alt="Order ${transaction.orderId}" class="order-screenshot" onclick="openImageModal(this.src)">
                    </div>
                ` : ''}
            </div>
        </div>
    `;
  }

  createItemHTML(item: Item): string {
    return `
        <div class="item">
            ${item.imageUrl ? `
                <div class="item-image">
                    <img src="${item.imageUrl}" alt="${item.name}" onerror="this.style.display='none'">
                </div>
            ` : ''}
            <div class="item-details">
                <div class="item-name">${item.name}</div>
                <div class="item-price">$${item.price.toFixed(2)}</div>
                ${item.quantity > 1 ? `<div class="item-quantity">Qty: ${item.quantity}</div>` : ''}
                ${item.seller ? `<div class="item-seller">Sold by: ${item.seller}</div>` : ''}
            </div>
        </div>
    `;
  }

  formatDate(dateString: string): string {
    try {
      if (!dateString) return '';
      
      // Try to parse the date
      let date;
      if (dateString.includes('-')) {
        date = parseISO(dateString);
      } else {
        date = new Date(dateString);
      }
      
      return format(date, 'MMM dd, yyyy');
    } catch (error) {
      return dateString; // Return original if parsing fails
    }
  }

  getRelativePath(absolutePath: string): string {
    // Convert absolute paths to relative paths for HTML
    // Screenshots are in ./output/screenshots/ and HTML is in ./output/
    // So we need to remove the ./output/ prefix and make it relative
    
    if (absolutePath.includes('output/screenshots/')) {
      // Extract just the filename and make it relative to screenshots folder
      const filename = path.basename(absolutePath);
      return `screenshots/${filename}`;
    }
    
    if (absolutePath.includes('screenshots/')) {
      // Already relative or contains screenshots path
      return absolutePath.replace(/.*screenshots\//, 'screenshots/');
    }
    
    // If it's just a filename, assume it's in screenshots
    if (!absolutePath.includes('/')) {
      return `screenshots/${absolutePath}`;
    }
    
    // Default: return as-is
    return absolutePath;
  }

  getCSS(): string {
    return `
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f5f5f5;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }

        .header {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }

        .header h1 {
            color: #232f3e;
            margin-bottom: 20px;
        }

        .metadata {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
        }

        .meta-item {
            display: flex;
            flex-direction: column;
        }

        .label {
            font-weight: 600;
            color: #666;
            font-size: 0.9em;
        }

        .value {
            font-size: 1.1em;
            margin-top: 2px;
        }

        .total-amount {
            font-weight: bold;
            color: #007600;
            font-size: 1.3em;
        }

        .controls {
            margin-bottom: 20px;
            display: flex;
            gap: 10px;
        }

        .btn {
            padding: 8px 16px;
            background: #ff9900;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }

        .btn:hover {
            background: #e68900;
        }

        .transactions {
            display: flex;
            flex-direction: column;
            gap: 15px;
        }

        .transaction {
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            overflow: hidden;
        }

        .transaction-header {
            padding: 20px;
            cursor: pointer;
            user-select: none;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #eee;
        }

        .transaction-header:hover {
            background-color: #f8f9fa;
        }

        .transaction-main {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex: 1;
        }

        .order-info {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }

        .order-id {
            font-weight: 600;
            color: #232f3e;
        }

        .order-date {
            color: #666;
            font-size: 0.9em;
        }

        .order-amount-container {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
        }

        .order-amount {
            font-weight: bold;
            font-size: 1.2em;
        }

        .order-amount-charged {
            color: #dc3545; /* Red for charges */
        }

        .order-amount-refunded {
            color: #28a745; /* Green for refunded orders */
        }

        .refund-amount {
            font-size: 0.9em;
            color: #28a745;
            font-weight: 500;
            margin-top: 2px;
        }

        .expand-icon {
            transition: transform 0.2s ease;
            font-size: 1.2em;
            color: #666;
        }

        .transaction.expanded .expand-icon {
            transform: rotate(180deg);
        }

        .transaction-details {
            padding: 0 20px;
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.3s ease, padding 0.3s ease;
        }

        .transaction.expanded .transaction-details {
            max-height: 2000px;
            padding: 20px;
        }

        .order-link {
            margin-bottom: 15px;
        }

        .amazon-link {
            display: inline-block;
            padding: 8px 16px;
            background: #ff9900;
            color: white;
            text-decoration: none;
            border-radius: 4px;
            font-weight: 500;
            font-size: 0.9em;
            transition: background-color 0.2s ease;
        }

        .amazon-link:hover {
            background: #e68900;
            text-decoration: none;
            color: white;
        }

        .recipient, .address, .payment-method, .tracking {
            margin-bottom: 10px;
            padding: 8px;
            background: #f8f9fa;
            border-radius: 4px;
            font-size: 0.9em;
        }

        .items {
            margin-top: 20px;
        }

        .items h4 {
            margin-bottom: 15px;
            color: #232f3e;
        }

        .items-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 15px;
        }

        .item {
            display: flex;
            gap: 15px;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 8px;
            border: 1px solid #eee;
        }

        .item-image {
            flex-shrink: 0;
            width: 80px;
            height: 80px;
        }

        .item-image img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            border-radius: 4px;
        }

        .item-details {
            flex: 1;
        }

        .item-name {
            font-weight: 500;
            margin-bottom: 5px;
            line-height: 1.4;
        }

        .item-price {
            font-weight: bold;
            color: #007600;
            margin-bottom: 5px;
        }

        .item-quantity, .item-seller {
            font-size: 0.9em;
            color: #666;
        }

        .screenshot-section {
            margin-top: 20px;
        }

        .screenshot-section h4 {
            margin-bottom: 10px;
            color: #232f3e;
        }

        .order-screenshot {
            max-width: 100%;
            height: auto;
            border: 1px solid #ddd;
            border-radius: 4px;
            cursor: pointer;
        }

        .order-screenshot:hover {
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        }

        .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.9);
        }

        .modal-content {
            margin: auto;
            display: block;
            max-width: 90%;
            max-height: 90%;
            margin-top: 2%;
        }

        .close {
            position: absolute;
            top: 15px;
            right: 35px;
            color: #f1f1f1;
            font-size: 40px;
            font-weight: bold;
            cursor: pointer;
        }

        .close:hover {
            color: #bbb;
        }

        @media (max-width: 768px) {
            .container {
                padding: 10px;
            }
            
            .transaction-main {
                flex-direction: column;
                align-items: flex-start;
                gap: 10px;
            }
            
            .items-grid {
                grid-template-columns: 1fr;
            }
            
            .item {
                flex-direction: column;
                text-align: center;
            }
            
            .item-image {
                align-self: center;
            }
        }

        @media print {
            .controls {
                display: none;
            }
            
            .transaction-details {
                max-height: none !important;
                padding: 20px !important;
            }
            
            .expand-icon {
                display: none;
            }
        }
    `;
  }

  getJavaScript(): string {
    return `
        function toggleTransaction(orderId) {
            const transaction = document.querySelector(\`[data-order-id="\${orderId}"]\`);
            transaction.classList.toggle('expanded');
        }

        function toggleAll(expand) {
            const transactions = document.querySelectorAll('.transaction');
            transactions.forEach(transaction => {
                if (expand) {
                    transaction.classList.add('expanded');
                } else {
                    transaction.classList.remove('expanded');
                }
            });
        }

        function openImageModal(src) {
            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.innerHTML = \`
                <span class="close" onclick="this.parentElement.remove()">&times;</span>
                <img class="modal-content" src="\${src}" alt="Order Screenshot">
            \`;
            document.body.appendChild(modal);
            modal.style.display = 'block';
            
            modal.onclick = function(event) {
                if (event.target === modal) {
                    modal.remove();
                }
            };
        }
    `;
  }
}

export default HTMLGenerator;