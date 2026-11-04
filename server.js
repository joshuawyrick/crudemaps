// Crude Maps web server — no dependencies, just Node.
// Serves the app from /public and hands the Google Maps key (from Replit Secrets) to the browser at /config.js,
// so the key never has to be saved in GitHub.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 5000;
const ROOT = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};
const NO_CACHE = new Set(['/', '/index.html', '/app.js', '/styles.css', '/locations.js', '/sw.js', '/manifest.webmanifest']);

function configScript() {
  const cfg = {
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
    mapId: process.env.GOOGLE_MAP_ID || 'DEMO_MAP_ID'
  };
  return 'window.CRUDE_MAPS_CONFIG = ' + JSON.stringify(cfg) + ';\n';
}

function send(res, status, headers, body, method) {
  res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' }, headers));
  res.end(method === 'HEAD' ? undefined : body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { 'Content-Type': 'text/plain' }, 'Method not allowed', req.method);
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (e) { return send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad request', req.method); }

  if (pathname === '/config.js') {
    return send(res, 200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' }, configScript(), req.method);
  }
  if (pathname === '/healthz') return send(res, 200, { 'Content-Type': 'text/plain' }, 'ok', req.method);

  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden', req.method);

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found', req.method);
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const rel = '/' + path.relative(ROOT, file).split(path.sep).join('/');
    const cache = NO_CACHE.has(rel) ? 'no-cache' : 'public, max-age=604800';
    send(res, 200, { 'Content-Type': type, 'Cache-Control': cache }, data, req.method);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Crude Maps running on port ${PORT}`);
  if (!process.env.GOOGLE_MAPS_API_KEY) console.log('Note: GOOGLE_MAPS_API_KEY is not set yet, so the map will ask for it.');
});
