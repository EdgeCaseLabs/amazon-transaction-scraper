#!/usr/bin/env node

import * as http from 'http';
import * as fs from 'fs-extra';
import * as path from 'path';
import { exec } from 'child_process';

const PORT = 3000;
const BASE_DIR = path.join(__dirname, '..');

// MIME types for common file extensions
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

async function findHTMLFiles(): Promise<string[]> {
  const htmlFiles: string[] = [];

  // Search in output and output-* directories
  const dirs = await fs.readdir(BASE_DIR);
  const outputDirs = dirs.filter(d => d === 'output' || d.startsWith('output-'));

  for (const dir of outputDirs) {
    const dirPath = path.join(BASE_DIR, dir);
    const stat = await fs.stat(dirPath);

    if (stat.isDirectory()) {
      const files = await fs.readdir(dirPath);
      const htmlInDir = files
        .filter(f => f.endsWith('.html'))
        .map(f => path.join(dir, f));
      htmlFiles.push(...htmlInDir);
    }
  }

  return htmlFiles.sort();
}

function generateIndexHTML(htmlFiles: string[]): string {
  const fileList = htmlFiles
    .map(file => {
      const fileName = path.basename(file);
      const dirName = path.dirname(file);
      return `
        <li class="file-item">
          <a href="/${file}" class="file-link">
            <span class="file-name">${fileName}</span>
            <span class="file-path">${dirName}/</span>
          </a>
        </li>
      `;
    })
    .join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Amazon Transaction Reports</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            padding: 40px;
        }

        h1 {
            color: #232f3e;
            margin-bottom: 10px;
            font-size: 2em;
        }

        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 1.1em;
        }

        .files-list {
            list-style: none;
        }

        .file-item {
            margin-bottom: 10px;
        }

        .file-link {
            display: flex;
            flex-direction: column;
            padding: 15px 20px;
            background: #f8f9fa;
            border-radius: 8px;
            text-decoration: none;
            color: inherit;
            transition: all 0.2s ease;
            border-left: 4px solid #ff9900;
        }

        .file-link:hover {
            background: #e9ecef;
            transform: translateX(5px);
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }

        .file-name {
            font-weight: 600;
            color: #232f3e;
            font-size: 1.1em;
            margin-bottom: 5px;
        }

        .file-path {
            font-size: 0.9em;
            color: #666;
        }

        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #666;
        }

        .empty-state svg {
            width: 100px;
            height: 100px;
            margin-bottom: 20px;
            opacity: 0.3;
        }

        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            text-align: center;
            color: #666;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📦 Amazon Transaction Reports</h1>
        <p class="subtitle">Select a report to view</p>

        ${htmlFiles.length > 0 ? `
            <ul class="files-list">
                ${fileList}
            </ul>
        ` : `
            <div class="empty-state">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p>No HTML reports found in output directories.</p>
                <p style="margin-top: 10px;">Run <code style="background: #f8f9fa; padding: 2px 8px; border-radius: 4px;">pnpm start</code> to generate reports.</p>
            </div>
        `}

        <div class="footer">
            Server running on <strong>http://localhost:${PORT}</strong>
        </div>
    </div>
</body>
</html>
  `;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || '/';

    // Serve index page
    if (url === '/') {
      const htmlFiles = await findHTMLFiles();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(generateIndexHTML(htmlFiles));
      return;
    }

    // Serve static files
    const filePath = path.join(BASE_DIR, decodeURIComponent(url));

    // Security check: ensure file is within BASE_DIR
    const resolvedPath = path.resolve(filePath);
    const resolvedBase = path.resolve(BASE_DIR);

    if (!resolvedPath.startsWith(resolvedBase)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // Check if file exists
    if (!await fs.pathExists(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    // Read and serve file
    const stat = await fs.stat(filePath);

    if (stat.isDirectory()) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Directory listing not allowed');
      return;
    }

    const content = await fs.readFile(filePath);
    const mimeType = getMimeType(filePath);

    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(content);

  } catch (error) {
    console.error('Server error:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server started at http://localhost:${PORT}`);
  console.log(`📂 Serving files from: ${BASE_DIR}`);
  console.log(`\n✨ Opening browser...`);

  // Open browser automatically
  const url = `http://localhost:${PORT}`;
  const platform = process.platform;

  let command: string;
  if (platform === 'darwin') {
    command = `open ${url}`;
  } else if (platform === 'win32') {
    command = `start ${url}`;
  } else {
    command = `xdg-open ${url}`;
  }

  exec(command, (error) => {
    if (error) {
      console.log(`\n👉 Open your browser to: ${url}`);
    }
  });

  console.log(`\nPress Ctrl+C to stop the server`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down server...');
  server.close(() => {
    console.log('✅ Server stopped');
    process.exit(0);
  });
});
