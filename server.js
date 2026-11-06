// Crude Maps web server — no dependencies, just Node 18+.
// Serves the app from /public and hands the Google Maps key (from Replit Secrets) to the browser at /config.js,
// so the key never has to be saved in GitHub.
// /api/trucks returns live truck positions from Samsara. The Samsara key stays here on the server and is never
// sent to the browser; the feed is locked behind APP_PASSCODE because the website itself is public.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const samsaraToken = () => (process.env.SAMSARA_API_TOKEN || '').trim();
const passcode = () => (process.env.APP_PASSCODE || '').trim();
const SAMSARA_BASE = (process.env.SAMSARA_API_BASE || 'https://api.samsara.com').replace(/\/+$/, '');

function configScript() {
  const cfg = {
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
    mapId: process.env.GOOGLE_MAP_ID || 'DEMO_MAP_ID',
    trucks: !!samsaraToken()
  };
  return 'window.CRUDE_MAPS_CONFIG = ' + JSON.stringify(cfg) + ';\n';
}

function send(res, status, headers, body, method) {
  res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' }, headers));
  res.end(method === 'HEAD' ? undefined : body);
}
function sendJSON(res, status, obj, method) {
  send(res, status, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' }, JSON.stringify(obj), method);
}

/* ---------- passcode check with lockout after repeated misses ---------- */
const MAX_MISSES = 8;
const LOCK_MS = 15 * 60 * 1000;
const misses = new Map(); // ip -> { n, until }
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}
function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function checkPass(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = misses.get(ip);
  if (rec && rec.until > now) return { ok: false, locked: true };
  const given = String(req.headers['x-crude-pass'] || '');
  if (given && sameSecret(given, passcode())) { misses.delete(ip); return { ok: true }; }
  const n = (rec && rec.until <= now && rec.n >= MAX_MISSES ? 0 : (rec ? rec.n : 0)) + 1;
  misses.set(ip, { n, until: n >= MAX_MISSES ? now + LOCK_MS : 0 });
  if (misses.size > 5000) misses.clear();
  return { ok: false, locked: n >= MAX_MISSES };
}

/* ---------- Samsara live locations (shared 10-second cache) ---------- */
const CACHE_MS = 10 * 1000;
let truckCache = { at: 0, data: null, pending: null };

async function fetchSamsaraTrucks() {
  const trucks = [];
  let after = '';
  for (let page = 0; page < 25; page++) {
    const url = new URL(SAMSARA_BASE + '/fleet/vehicles/stats');
    url.searchParams.set('types', 'gps');
    if (after) url.searchParams.set('after', after);
    const r = await fetch(url, {
      headers: { Authorization: 'Bearer ' + samsaraToken(), Accept: 'application/json' },
      signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) {
      const err = new Error('Samsara answered ' + r.status);
      err.status = r.status;
      throw err;
    }
    const body = await r.json();
    for (const v of body.data || []) {
      const g = v.gps;
      if (!g || typeof g.latitude !== 'number' || typeof g.longitude !== 'number') continue;
      trucks.push({
        id: String(v.id),
        name: String(v.name || 'Vehicle ' + v.id),
        lat: g.latitude,
        lng: g.longitude,
        heading: typeof g.headingDegrees === 'number' ? g.headingDegrees : null,
        mph: typeof g.speedMilesPerHour === 'number' ? g.speedMilesPerHour : null,
        time: g.time || null,
        place: (g.reverseGeo && g.reverseGeo.formattedLocation) || ''
      });
    }
    const pg = body.pagination || {};
    if (!pg.hasNextPage || !pg.endCursor) break;
    after = pg.endCursor;
  }
  trucks.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return trucks;
}

function getTrucks() {
  const now = Date.now();
  if (truckCache.data && now - truckCache.at < CACHE_MS) return Promise.resolve(truckCache);
  if (!truckCache.pending) {
    truckCache.pending = fetchSamsaraTrucks()
      .then(trucks => { truckCache = { at: Date.now(), data: trucks, pending: null }; return truckCache; })
      .catch(err => { truckCache.pending = null; throw err; });
  }
  return truckCache.pending;
}

async function handleTrucks(req, res) {
  if (!samsaraToken()) return sendJSON(res, 503, { error: 'not_configured', message: 'SAMSARA_API_TOKEN is not set.' }, req.method);
  if (!passcode()) return sendJSON(res, 503, { error: 'no_passcode', message: 'APP_PASSCODE is not set, so the truck feed is turned off.' }, req.method);
  const pass = checkPass(req);
  if (pass.locked) return sendJSON(res, 429, { error: 'locked', message: 'Too many wrong passcodes. Try again in 15 minutes.' }, req.method);
  if (!pass.ok) return sendJSON(res, 401, { error: 'bad_passcode' }, req.method);
  try {
    const c = await getTrucks();
    sendJSON(res, 200, { updated: new Date(c.at).toISOString(), trucks: c.data }, req.method);
  } catch (err) {
    const auth = err.status === 401 || err.status === 403;
    console.warn('[trucks]', err.message);
    sendJSON(res, 502, {
      error: auth ? 'samsara_auth' : 'samsara_down',
      message: auth ? 'Samsara turned down the key. Check SAMSARA_API_TOKEN and that it can read vehicle stats.' : 'Couldn’t reach Samsara right now.'
    }, req.method);
  }
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
  if (pathname === '/api/trucks') { handleTrucks(req, res); return; }

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
  if (!samsaraToken()) console.log('Note: SAMSARA_API_TOKEN is not set, so live trucks are hidden.');
  else if (!passcode()) console.log('Note: APP_PASSCODE is not set, so the live truck feed stays locked.');
});
