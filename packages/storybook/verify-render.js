import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, 'storybook-static');
const PORT = 13337;

// Simple static server
const server = http.createServer((req, res) => {
  let filePath = path.join(STATIC_DIR, req.url === '/' ? 'index.html' : req.url);
  // Handle query params in url
  filePath = filePath.split('?')[0];
  
  const ext = path.extname(filePath);
  let contentType = 'text/html';
  if (ext === '.js') contentType = 'text/javascript';
  if (ext === '.css') contentType = 'text/css';
  if (ext === '.json') contentType = 'application/json';
  if (ext === '.svg') contentType = 'image/svg+xml';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // Try to serve index.html for 404s (SPA fallback)? Not needed for iframe.html
        res.writeHead(404);
        res.end('Not found: ' + filePath);
      } else {
        res.writeHead(500);
        res.end('Server error: ' + err.code);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  
  try {
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    });
    const page = await browser.newPage();
    
    // URL for DetailsView iframe
    const url = `http://localhost:${PORT}/iframe.html?id=views-detailsview--default&viewMode=story`;
    console.log(`Navigating to ${url}`);
    
    await page.goto(url, { waitUntil: 'networkidle0' });
    
    // Wait for the root element
    await page.waitForSelector('#storybook-root');
    
    // Wait a bit for React to hydrate and atoms to settle
    console.log('Waiting for render...');
    await new Promise(r => setTimeout(r, 3000));

    const content = await page.evaluate(() => {
      const root = document.querySelector('#storybook-root');
      return root ? root.innerText : 'NO ROOT FOUND';
    });

    console.log('--- RENDERED CONTENT ---');
    console.log(content);
    console.log('------------------------');

    const html = await page.content();
    // Check for specific mock data
    if (content.includes('Update README.md')) {
      console.log('✅ VERIFICATION SUCCESS: Data is rendered.');
      process.exit(0);
    } else if (content.includes('No PR selected')) {
      console.log('❌ VERIFICATION FAILURE: "No PR selected" state found.');
      process.exit(1);
    } else {
        console.log('⚠️  Ambiguous content. Dumping HTML snippet:');
        console.log(html.substring(0, 500));
        process.exit(1);
    }

  } catch (e) {
    console.error('Error during verification:', e);
    process.exit(1);
  } finally {
    server.close();
    process.exit(0); // Ensure cleanup
  }
});
