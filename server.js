// Simple HTTPS static file server
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8443;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
};

const server = https.createServer({
  key:  fs.readFileSync(path.join(ROOT, 'server.key')),
  cert: fs.readFileSync(path.join(ROOT, 'server.crt')),
}, (req, res) => {
  let filePath = path.join(ROOT, req.url.split('?')[0]);
  if (filePath.endsWith('/')) filePath = path.join(filePath, 'index.html');
  if (!path.extname(filePath)) filePath += '.html';

  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');

  // Don't cache HTML (allow updates)
  if (ext === '.html') {
    res.setHeader('Cache-Control', 'no-cache');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fallback to index.html for SPA-like navigation
      fs.readFile(path.join(ROOT, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end('404');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data2);
        }
      });
    } else {
      res.writeHead(200);
      res.end(data);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('HTTPS server running at https://0.0.0.0:' + PORT);
});
