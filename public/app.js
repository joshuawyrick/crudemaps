/* Crude Maps — find a location, route to it on a Google map, and follow live guidance. */
'use strict';
(function () {

  const CFG = window.CRUDE_MAPS_CONFIG || {};
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cm:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('cm:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  /* ---------------- geo math ---------------- */
  const R_M = 6371008.8;
  const M_PER_MI = 1609.344;
  const toRad = x => x * Math.PI / 180;
  function arc(a, b) {
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  const meters = (a, b) => arc(a, b) * R_M;
  const miles = (a, b) => meters(a, b) / M_PER_MI;
  function bearing(a, b) {
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  const DIR_SHORT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const DIR_LONG = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const dirIdx = deg => Math.round(deg / 45) % 8;

  function fmtMiles(mi) {
    if (mi == null || !isFinite(mi)) return '';
    if (mi < 0.19) return Math.max(50, Math.round(mi * 5280 / 50) * 50) + ' ft';
    if (mi < 10) return mi.toFixed(1) + ' mi';
    return Math.round(mi) + ' mi';
  }
  const fmtMeters = m => fmtMiles(m / M_PER_MI);
  function fmtDuration(sec) {
    const m = Math.max(1, Math.round(sec / 60));
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60), r = m % 60;
    return h + ' hr' + (r ? ' ' + r + ' min' : '');
  }
  const fmtClock = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function spokenDist(m) {
    const mi = m / M_PER_MI;
    if (mi < 0.19) return Math.max(100, Math.round(mi * 5280 / 100) * 100) + ' feet';
    if (Math.abs(mi - 0.5) < 0.08) return 'half a mile';
    if (Math.abs(mi - 1) < 0.08) return '1 mile';
    return mi.toFixed(1) + ' miles';
  }
  const lowerFirst = s => s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  const spokenName = s => String(s).toLowerCase();

  /* ---------------- data ---------------- */
  const places = (window.LOCATIONS || []).map(([name, lat, lng, op], i) => ({
    i, name, lat, lng, op: op || '',
    key: name + '@' + lat + ',' + lng,
    hay: (name + ' ' + (op || '')).toLowerCase(),
    d: null, b: 0
  }));
  const byKey = new Map(places.map(p => [p.key, p]));
  const operators = [...new Set(places.map(p => p.op).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const navUrl = {
    google: p => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`,
    apple: p => `https://maps.apple.com/?daddr=${p.lat},${p.lng}&dirflg=d`,
    waze: p => `https://waze.com/ul?ll=${p.lat},${p.lng}&navigate=yes`,
    share: p => `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`
  };

  const state = {
    q: '', op: '', sort: 'az', tab: 'list',
    me: null, lastListPos: null, gps: 'off', watchId: null,
    favs: new Set(store.get('favs', [])),
    recents: store.get('recents', []),
    mapType: store.get('mapType', 'hybrid'),
    traffic: store.get('traffic', false),
    labels: store.get('labels', true),
    voice: store.get('voice', true)
  };

  /* ---------------- icons ---------------- */
  const STAR = '<svg class="fav" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3.2l2.6 5.5 6 .7-4.4 4.1 1.1 5.9L12 16.5l-5.3 2.9 1.1-5.9-4.4-4.1 6-.7z"/></svg>';
  const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  const normMan = m => String(m || '').toUpperCase().replace(/-/g, '_');
  function arrowSVG(man) {
    const m = normMan(man);
    if (m === 'ARRIVE' || m === 'DESTINATION') {
      return '<svg class="arw" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.8a7.2 7.2 0 0 0-7.2 7.2c0 5.2 7.2 13.2 7.2 13.2s7.2-8 7.2-13.2A7.2 7.2 0 0 0 12 1.8zm0 9.9a2.7 2.7 0 1 1 0-5.4 2.7 2.7 0 0 1 0 5.4z"/></svg>';
    }
    if (/UTURN|U_TURN/.test(m)) {
      const flip = /RIGHT/.test(m) ? ' style="transform:scaleX(-1)"' : '';
      return `<svg class="arw" viewBox="0 0 24 24" aria-hidden="true"${flip}><path d="M16.5 21.5V9.5a4.5 4.5 0 0 0-9 0v8" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/><path d="M3.8 14.6 7.5 18.8l3.7-4.2" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    if (/ROUNDABOUT/.test(m)) {
      return '<svg class="arw" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="4.6" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M12 13.6v8" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/><path d="m14.6 2.2 2.8 2.8-3.9.9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    let rot = 0;
    if (/SHARP_LEFT/.test(m)) rot = -135;
    else if (/SHARP_RIGHT/.test(m)) rot = 135;
    else if (/(SLIGHT|KEEP|FORK|RAMP|MERGE)_?LEFT|LEFT_(SLIGHT|FORK|RAMP)/.test(m)) rot = -45;
    else if (/(SLIGHT|KEEP|FORK|RAMP|MERGE)_?RIGHT|RIGHT_(SLIGHT|FORK|RAMP)/.test(m)) rot = 45;
    else if (/LEFT/.test(m)) rot = -90;
    else if (/RIGHT/.test(m)) rot = 90;
    return `<svg class="arw" viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(${rot} 12 12)"><path fill="currentColor" d="M12 2.2l7.6 7.7h-5.1v11.9h-5V9.9H4.4z"/></g></svg>`;
  }

  /* ---------------- small UI helpers ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  /* ---------------- list ---------------- */
  function filtered() {
    const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    const opOK = p => state.noOp ? !p.op : (!state.op || p.op === state.op);
    const out = places.filter(p => opOK(p) && terms.every(t => p.hay.includes(t)));
    if (state.sort === 'near' && state.me) out.sort((a, b) => a.d - b.d);
    return out;
  }
  function rowHTML(p) {
    const dist = state.me ? `<span class="row-dist"><b>${fmtMiles(p.d)}</b><small>${DIR_SHORT[p.b]}</small></span>` : '';
    return `<li><button type="button" class="row" data-i="${p.i}"><span class="row-main"><span class="row-name">${state.favs.has(p.key) ? STAR : ''}<span>${esc(p.name)}</span></span>${p.op ? `<span class="row-op">${esc(p.op)}</span>` : ''}</span>${dist}</button></li>`;
  }
  function renderList() {
    const list = filtered();
    $('#rows').innerHTML = list.map(rowHTML).join('');
    const narrowed = state.q || state.op;
    $('#count').textContent = narrowed ? `${list.length} of ${places.length} locations` : `${places.length} locations`;
    $('#count').hidden = !list.length;
    $('#empty').hidden = list.length > 0;
    if (!list.length) {
      $('#empty-text').textContent = state.q ? `No locations match “${state.q}”.` : 'No locations for this operator.';
      $('#empty-clear').textContent = state.q ? 'Clear search' : 'Show all operators';
    }
  }
  function syncSort() {
    $$('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort)));
  }
  function renderSaved() {
    const favs = places.filter(p => state.favs.has(p.key));
    if (state.me) favs.sort((a, b) => a.d - b.d);
    const rec = state.recents.map(k => byKey.get(k)).filter(Boolean);
    $('#saved').innerHTML =
      '<h2 class="sec">Saved locations</h2>' +
      (favs.length ? `<ul class="rows">${favs.map(rowHTML).join('')}</ul>` : '<p class="sec-empty">Tap the star on any location to keep it here.</p>') +
      '<h2 class="sec">Recently viewed</h2>' +
      (rec.length ? `<ul class="rows">${rec.map(rowHTML).join('')}</ul>` : '<p class="sec-empty">Locations you open will show up here.</p>');
  }
  function addRecent(p) {
    state.recents = [p.key, ...state.recents.filter(k => k !== p.key)].slice(0, 12);
    store.set('recents', state.recents);
  }
  function toggleFav(p) {
    if (state.favs.has(p.key)) state.favs.delete(p.key); else state.favs.add(p.key);
    store.set('favs', [...state.favs]);
    syncStar();
    renderList();
    renderSaved();
    toast(state.favs.has(p.key) ? 'Saved' : 'Removed from saved');
  }

  /* ---------------- install prompt ---------------- */
  let installEvt = null;
  function renderInstall() {
    const el = $('#install');
    if (isStandalone() || store.get('installDismissed', false)) { el.hidden = true; return; }
    if (installEvt) {
      el.innerHTML = `<p>Install Crude Maps on this phone for one-tap access.</p><button type="button" class="btn btn-sm" data-act="install">Install</button><button type="button" class="x" data-act="dismiss" aria-label="Dismiss">${X_ICON}</button>`;
      el.hidden = false;
    } else if (isIOS) {
      el.innerHTML = `<p>To install: in Safari, tap Share (it may be under •••), then Add to Home Screen.</p><button type="button" class="x" data-act="dismiss" aria-label="Dismiss">${X_ICON}</button>`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderInstall(); });
  window.addEventListener('appinstalled', () => { installEvt = null; store.set('installDismissed', true); renderInstall(); });

  /* ---------------- GPS ---------------- */
  const GPS_TEXT = { off: 'Use my location', finding: 'Finding you…', on: 'Location on', denied: 'Location blocked', unsupported: 'No location' };
  function setGps(s) {
    state.gps = s;
    $('#gps').dataset.state = s;
    $('#gps-text').textContent = GPS_TEXT[s];
    $('#loc-hint').hidden = s === 'on' || s === 'finding';
    $('#loc-btn').hidden = s === 'denied' || s === 'unsupported';
    $('#loc-hint-text').textContent =
      s === 'denied' ? 'Location is blocked for Crude Maps. Allow it in your iPhone Settings under Privacy & Security, then Location Services, to see distances and get directions.' :
      s === 'unsupported' ? 'This browser can’t share your location, so distances and directions are off.' :
      'Turn on location to see the nearest locations first.';
  }
  function startGps() {
    if (!('geolocation' in navigator)) { setGps('unsupported'); return; }
    if (state.watchId != null) return;
    if (!state.me) setGps('finding');
    state.watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });
  }
  function onPos(pos) {
    const c = pos.coords;
    const me = { lat: c.latitude, lng: c.longitude, acc: c.accuracy || 0, t: pos.timestamp };
    const first = !state.me;
    state.me = me;
    store.set('gpsOK', true);
    setGps('on');
    for (const p of places) { p.d = miles(me, p); p.b = dirIdx(bearing(me, p)); }
    if (first) { state.sort = 'near'; syncSort(); }
    if (first || !state.lastListPos || miles(state.lastListPos, me) > 0.25) {
      state.lastListPos = me;
      renderList();
      if (state.tab === 'saved') renderSaved();
    }
    refreshSheetDistance();
    MapView.onPosition(me);
  }
  function onPosErr(err) {
    if (err && err.code === 1) {
      if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
      store.set('gpsOK', false);
      setGps('denied');
    } else if (!state.me) {
      setGps('finding');
    }
  }
  function waitForPosition(ms) {
    return new Promise(resolve => {
      if (state.me) return resolve(state.me);
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (state.me || state.gps === 'denied' || Date.now() - t0 > ms) { clearInterval(iv); resolve(state.me); }
      }, 250);
    });
  }

  /* ---------------- detail sheet ---------------- */
  const sheet = $('#sheet'), scrim = $('#scrim');
  let sheetP = null, sheetOpen = false;
  function openPlace(i) {
    const p = places[i];
    if (!p) return;
    sheetP = p;
    addRecent(p);
    $('#d-name').textContent = p.name;
    $('#d-op').textContent = p.op;
    $('#d-op').hidden = !p.op;
    refreshSheetDistance();
    $('#d-google').href = navUrl.google(p);
    $('#d-apple').href = navUrl.apple(p);
    $('#d-waze').href = navUrl.waze(p);
    $('#d-coords').textContent = `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
    syncStar();
    if (!sheetOpen) history.pushState({ cmSheet: true }, '');
    sheetOpen = true;
    sheet.scrollTop = 0;
    sheet.classList.add('open');
    scrim.classList.add('open');
    setTimeout(() => sheet.focus({ preventScroll: true }), 60);
  }
  function refreshSheetDistance() {
    if (!sheetP) return;
    const el = $('#d-dist');
    if (state.me) { el.textContent = `${fmtMiles(sheetP.d)} ${DIR_LONG[sheetP.b]} of you, straight line`; el.hidden = false; }
    else el.hidden = true;
  }
  function syncStar() {
    if (!sheetP) return;
    const on = state.favs.has(sheetP.key);
    $('#d-star').setAttribute('aria-pressed', String(on));
    $('#d-star').setAttribute('aria-label', on ? 'Remove from saved' : 'Save this location');
  }
  function hideSheet() {
    sheetOpen = false;
    sheet.classList.remove('open');
    scrim.classList.remove('open');
  }
  function closeSheet() {
    if (sheetOpen && history.state && history.state.cmSheet) history.back();
    else hideSheet();
  }
  window.addEventListener('popstate', () => { if (sheetOpen) hideSheet(); });

  /* ---------------- tabs ---------------- */
  function setTab(t) {
    state.tab = t;
    for (const v of ['list', 'map', 'saved']) $('#view-' + v).hidden = v !== t;
    $$('.tab').forEach(b => b.setAttribute('aria-current', b.dataset.tab === t ? 'page' : 'false'));
    if (t === 'map') MapView.show();
    if (t === 'saved') renderSaved();
  }

  /* ---------------- routes: normalize Google results ---------------- */
  function ll(v) {
    if (!v) return null;
    if (v.latLng) return ll(v.latLng);
    if (v.location && !('lat' in v)) return ll(v.location);
    const lat = typeof v.lat === 'function' ? v.lat() : (v.lat != null ? v.lat : v.latitude);
    const lng = typeof v.lng === 'function' ? v.lng() : (v.lng != null ? v.lng : v.longitude);
    return (typeof lat === 'number' && typeof lng === 'number' && isFinite(lat) && isFinite(lng)) ? { lat, lng } : null;
  }
  function stripHtml(s) {
    const div = document.createElement('div');
    div.innerHTML = String(s || '').replace(/<div[^>]*>/gi, '. ').replace(/<wbr\s*\/?>/gi, '');
    return (div.textContent || '').replace(/\s+/g, ' ').replace(/\s+\./g, '.').trim();
  }
  const pathOf = arr => (arr || []).map(ll).filter(Boolean);

  function fromRouteClass(r, dest) {
    const steps = [];
    for (const leg of r.legs || []) {
      for (const s of leg.steps || []) {
        const ni = s.navigationInstruction || {};
        steps.push({
          text: stripHtml(s.instructions || ni.instructions || ''),
          maneuver: normMan(s.maneuver || ni.maneuver),
          meters: s.distanceMeters || 0,
          path: pathOf(s.path)
        });
      }
    }
    return finishRoute({ meters: r.distanceMeters || 0, seconds: (r.durationMillis || 0) / 1000, path: pathOf(r.path), steps }, dest);
  }
  function fromDirections(r, dest) {
    const leg = (r.legs || [])[0] || {};
    const steps = (leg.steps || []).map(s => ({
      text: stripHtml(s.instructions),
      maneuver: normMan(s.maneuver),
      meters: s.distance ? s.distance.value : 0,
      path: pathOf(s.path || s.lat_lngs)
    }));
    return finishRoute({
      meters: leg.distance ? leg.distance.value : 0,
      seconds: leg.duration ? leg.duration.value : 0,
      path: pathOf(r.overview_path),
      steps
    }, dest);
  }
  // Builds a single measured track for progress tracking; every point remembers its step.
  function finishRoute(r, dest) {
    const pts = [], sIdx = [];
    const stepsHavePath = r.steps.length > 0 && r.steps.every(s => s.path.length > 0);
    if (stepsHavePath) r.steps.forEach((s, i) => s.path.forEach(pt => { pts.push(pt); sIdx.push(i); }));
    else r.path.forEach(pt => { pts.push(pt); sIdx.push(-1); });
    if (!r.path.length) r.path = pts.slice();
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + meters(pts[k - 1], pts[k]));
    r.track = { pts, sIdx, cum, total: cum[cum.length - 1] || 0 };
    r.stepEnd = r.steps.map(() => 0);
    if (stepsHavePath) for (let k = 0; k < pts.length; k++) r.stepEnd[sIdx[k]] = cum[k];
    r.hasSteps = stepsHavePath;
    r.dest = dest;
    r.end = pts.length ? pts[pts.length - 1] : dest;
    r.offroad = meters(r.end, dest);
    if (!r.meters) r.meters = r.track.total;
    if (!r.seconds) r.seconds = r.meters / 13.4; // ~30 mph if Google gave no time
    return r;
  }
  // Where is `me` along the route? Searches near the last known spot first so out-and-back roads don't confuse it.
  function progress(r, me, lastAlong) {
    const { pts, sIdx, cum } = r.track;
    if (pts.length < 2) return { along: 0, offM: pts.length ? meters(me, pts[0]) : meters(me, r.dest), step: r.hasSteps ? 0 : -1 };
    const kx = Math.cos(toRad(me.lat)) * 111320, ky = 110540;
    const px = me.lng * kx, py = me.lat * ky;
    function scan(lo, hi) {
      let best = Infinity, bk = 0, bt = 0;
      for (let k = 0; k < pts.length - 1; k++) {
        if (cum[k + 1] < lo || cum[k] > hi) continue;
        const ax = pts[k].lng * kx, ay = pts[k].lat * ky;
        const dx = pts[k + 1].lng * kx - ax, dy = pts[k + 1].lat * ky - ay;
        const L2 = dx * dx + dy * dy;
        let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx - px, qy = ay + t * dy - py;
        const d2 = qx * qx + qy * qy;
        if (d2 < best) { best = d2; bk = k; bt = t; }
      }
      return { d: Math.sqrt(best), k: bk, t: bt };
    }
    let hit = null;
    if (lastAlong != null) {
      hit = scan(lastAlong - 300, lastAlong + 4000);
      if (hit.d > 60) hit = null;
    }
    if (!hit) hit = scan(-Infinity, Infinity);
    const along = cum[hit.k] + hit.t * (cum[hit.k + 1] - cum[hit.k]);
    return { along, offM: hit.d, step: sIdx[hit.k] };
  }

  /* ---------------- map (Google Maps JavaScript API) ---------------- */
  const MapView = (function () {
    const view = $('#view-map'), msg = $('#map-msg');
    let G = null, map = null, loading = null, initing = null, trafficLayer = null;
    const markers = [];
    let meMarker = null, accCircle = null, sel = null;
    let route = null, lines = [], offLine = null, nav = null, wake = null;

    function showMsg(title, body, retry) {
      msg.innerHTML = `<b>${esc(title)}</b><p>${esc(body)}</p>` + (retry ? '<button type="button" class="btn btn-sm" data-act="retry">Try again</button>' : '');
      msg.hidden = false;
    }
    msg.addEventListener('click', e => {
      if (e.target.closest('[data-act="retry"]')) { msg.hidden = true; init().catch(() => {}); }
    });

    function loadScript() {
      if (loading) return loading;
      loading = new Promise((resolve, reject) => {
        if (!CFG.googleMapsKey) { reject(new Error('nokey')); return; }
        window.gm_authFailure = () => showMsg('Google turned down the map key', 'Check that the key in Replit Secrets is correct and that it allows this website and the Maps JavaScript API.', false);
        window.__cmMapsReady = () => resolve();
        const s = document.createElement('script');
        s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(CFG.googleMapsKey) + '&v=weekly&loading=async&callback=__cmMapsReady';
        s.async = true;
        s.onerror = () => { s.remove(); reject(new Error('offline')); };
        document.head.appendChild(s);
      });
      loading.catch(() => { loading = null; });
      return loading;
    }

    function init() {
      if (map) return Promise.resolve(map);
      if (initing) return initing;
      initing = (async () => {
        try {
          await loadScript();
        } catch (e) {
          if (e.message === 'nokey') showMsg('The map needs a Google key', 'Add GOOGLE_MAPS_API_KEY in Replit Secrets, then restart the app. The location list still works without it.', false);
          else showMsg('The map didn’t load', 'Check your signal, then try again. The location list still works offline.', true);
          throw e;
        }
        const maps = await google.maps.importLibrary('maps');
        const marker = await google.maps.importLibrary('marker');
        G = { Map: maps.Map, Polyline: maps.Polyline, Circle: maps.Circle, TrafficLayer: maps.TrafficLayer, Marker: marker.AdvancedMarkerElement };
        msg.hidden = true;
        map = new G.Map($('#map'), {
          center: state.me ? { lat: state.me.lat, lng: state.me.lng } : { lat: 35.35, lng: -119.45 },
          zoom: state.me ? 11 : 9,
          mapId: CFG.mapId || 'DEMO_MAP_ID',
          mapTypeId: state.mapType,
          disableDefaultUI: true,
          gestureHandling: 'greedy',
          clickableIcons: false,
          keyboardShortcuts: false
        });
        if (!state.me) fitAll();
        trafficLayer = new G.TrafficLayer();
        if (state.traffic) trafficLayer.setMap(map);
        for (const p of places) {
          const el = document.createElement('div');
          el.className = 'pin';
          el.innerHTML = `<span class="dot"></span><span class="pin-label">${esc(p.name)}</span>`;
          const m = new G.Marker({ map, position: { lat: p.lat, lng: p.lng }, content: el, title: p.name });
          m.addListener('click', () => select(p, false));
          markers[p.i] = { m, el };
        }
        map.addListener('zoom_changed', syncLabels);
        map.addListener('dragstart', () => { if (nav) { nav.follow = false; $('#locate-btn').classList.add('attn'); } });
        map.addListener('click', () => closeLayers());
        syncLabels();
        syncLayerUI();
        if (state.me) onPosition(state.me);
        return map;
      })();
      initing.catch(() => { initing = null; });
      return initing;
    }

    function fitAll() {
      const ca = places.filter(p => p.lng < -114 && p.lat < 42.1);
      if (!ca.length || !map) return;
      map.fitBounds({
        north: Math.max(...ca.map(p => p.lat)), south: Math.min(...ca.map(p => p.lat)),
        east: Math.max(...ca.map(p => p.lng)), west: Math.min(...ca.map(p => p.lng))
      }, 30);
    }
    function syncLabels() {
      view.classList.toggle('show-labels', !!(map && state.labels && map.getZoom() >= 13));
    }

    function show() {
      init().then(() => { if (sel) refreshCard(); }).catch(() => {});
    }

    function onPosition(me) {
      if (!map) return;
      const pos = { lat: me.lat, lng: me.lng };
      if (!meMarker) {
        const el = document.createElement('div');
        el.className = 'me';
        meMarker = new G.Marker({ map, position: pos, content: el, zIndex: 100000, title: 'You are here' });
        accCircle = new G.Circle({ map, center: pos, radius: Math.min(me.acc || 0, 400), strokeOpacity: 0, fillColor: '#1A73E8', fillOpacity: 0.1, clickable: false });
      } else {
        meMarker.position = pos;
        accCircle.setCenter(pos);
        accCircle.setRadius(Math.min(me.acc || 0, 400));
      }
      refreshCard();
      if (nav) navUpdate(me);
    }

    /* selection card */
    function select(p, pan) {
      if (sel && markers[sel.i]) { markers[sel.i].el.classList.remove('sel'); markers[sel.i].m.zIndex = null; }
      sel = p;
      if (p && markers[p.i]) {
        const el = markers[p.i].el;
        if (!el.querySelector('.pin-img')) el.insertAdjacentHTML('afterbegin', '<img class="pin-img" src="brand/pin.png" alt="">');
        el.classList.add('sel');
        markers[p.i].m.zIndex = 50000;
      }
      if (p && pan && map) {
        map.panTo({ lat: p.lat, lng: p.lng });
        if (map.getZoom() < 15) map.setZoom(15);
      }
      refreshCard();
    }
    function refreshCard() {
      const card = $('#map-card');
      if (!sel || route) { card.hidden = true; return; }
      $('#mc-name').textContent = sel.name;
      $('#mc-sub').textContent = state.me ? `${fmtMiles(sel.d)} ${DIR_LONG[sel.b]}, straight line` : (sel.op || 'Tap for details');
      card.hidden = false;
    }

    /* layers */
    function syncLayerUI() {
      $$('.layer-grid button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.type === state.mapType)));
      $('#traffic').checked = state.traffic;
      $('#labels').checked = state.labels;
    }
    function setMapType(t) {
      state.mapType = t; store.set('mapType', t);
      if (map) map.setMapTypeId(t);
      syncLayerUI();
    }
    function setTraffic(on) {
      state.traffic = on; store.set('traffic', on);
      if (trafficLayer) trafficLayer.setMap(on ? map : null);
    }
    function setLabels(on) { state.labels = on; store.set('labels', on); syncLabels(); }
    function toggleLayers(force) {
      const panel = $('#layers');
      const open = force != null ? force : panel.hidden;
      panel.hidden = !open;
      $('#layers-btn').setAttribute('aria-expanded', String(open));
    }
    const closeLayers = () => toggleLayers(false);

    function locate() {
      if (!state.me) { startGps(); toast('Finding your location…'); return; }
      if (!map) return;
      if (nav) { nav.follow = true; $('#locate-btn').classList.remove('attn'); map.setZoom(Math.max(map.getZoom(), 16)); }
      else if (map.getZoom() < 13) map.setZoom(14);
      map.panTo({ lat: state.me.lat, lng: state.me.lng });
    }

    /* routing */
    async function computeRoute(origin, p) {
      const dest = { lat: p.lat, lng: p.lng };
      const lib = await google.maps.importLibrary('routes');
      let firstErr = null;
      if (lib.Route && typeof lib.Route.computeRoutes === 'function') {
        try {
          const res = await lib.Route.computeRoutes({
            origin, destination: dest, travelMode: 'DRIVING',
            fields: ['path', 'legs', 'distanceMeters', 'durationMillis', 'localizedValues', 'viewport']
          });
          const r0 = res && res.routes && res.routes[0];
          if (r0) return fromRouteClass(r0, dest);
          firstErr = new Error('noroute');
        } catch (e) {
          firstErr = e;
          console.warn('[Crude Maps] Routes API request failed, trying the Directions service.', e);
        }
      }
      if (lib.DirectionsService) {
        try {
          const res = await new lib.DirectionsService().route({ origin, destination: dest, travelMode: 'DRIVING' });
          const r0 = res && res.routes && res.routes[0];
          if (r0) return fromDirections(r0, dest);
        } catch (e) {
          console.warn('[Crude Maps] Directions service failed.', e);
          if (!firstErr || firstErr.message === 'noroute') firstErr = e;
        }
      }
      throw firstErr || new Error('noroute');
    }

    function routeError(e) {
      const t = String((e && (e.message || e.code)) || e || '');
      if (/not ?activated|not enabled|PERMISSION|REQUEST_DENIED|not authorized|API_KEY|ApiNotActivated|referer/i.test(t)) {
        return 'Directions aren’t turned on for this Google key yet. In Google Cloud, enable the Routes API for the key, then try again.';
      }
      if (/ZERO_RESULTS|NOT_FOUND|noroute/i.test(t)) return 'Google couldn’t find a driving route to this spot. Try Google Maps, or check the pin on Satellite.';
      return 'Couldn’t get directions right now. Check your signal and try again.';
    }

    function panelMode(mode) {
      const navOn = mode === 'nav';
      $('#route-panel').hidden = false;
      $('#map-card').hidden = true;
      $('#rp-stats').hidden = mode === 'loading' || mode === 'error';
      $('#rp-start').hidden = mode !== 'ready';
      $('#rp-retry').hidden = mode !== 'error';
      $('#rp-end').hidden = !navOn;
      $('#rp-voice').hidden = !navOn;
      $('#rp-steps-btn').hidden = !(mode === 'ready' || navOn);
      $('#rp-gmaps').hidden = navOn;
      view.classList.toggle('navigating', navOn);
      document.body.classList.toggle('nav-on', navOn);
      $('#nav-sign').hidden = !navOn;
    }
    function setNote(text, isErr) {
      const n = $('#rp-note');
      n.textContent = text || '';
      n.hidden = !text;
      n.classList.toggle('err', !!isErr);
    }

    let routeReq = 0, retryTarget = null;
    async function routeTo(p) {
      const req = ++routeReq;
      setTab('map');
      try { await init(); } catch (e) { return; }
      stopNav(true);
      clearLines();
      route = null;
      select(p, false);
      $('#rp-name').textContent = p.name;
      $('#rp-gmaps').href = navUrl.google(p);
      $('#rp-steps').hidden = true;
      $('#rp-steps-btn').setAttribute('aria-expanded', 'false');
      $('#rp-steps-btn').textContent = 'Steps';
      panelMode('loading');
      setNote('Finding the route…');
      if (!state.me) {
        startGps();
        await waitForPosition(15000);
        if (req !== routeReq) return;
        if (!state.me) {
          panelMode('error');
          setNote(state.gps === 'denied' ? 'Location is blocked, so directions can’t start from where you are. Allow location for Crude Maps in Settings.' : 'Still looking for your location. Make sure Location Services is on, then try again.', true);
          retryTarget = p;
          return;
        }
      }
      try {
        const r = await computeRoute({ lat: state.me.lat, lng: state.me.lng }, p);
        if (req !== routeReq) return;
        r.place = p;
        route = r;
        drawRoute(true);
        showRouteInfo();
        panelMode('ready');
      } catch (e) {
        if (req !== routeReq) return;
        console.warn('[Crude Maps] route failed', e);
        panelMode('error');
        setNote(routeError(e), true);
        retryTarget = p;
      }
    }

    function showRouteInfo() {
      const r = route, p = r.place;
      $('#rp-time').textContent = fmtDuration(r.seconds);
      $('#rp-dist').textContent = fmtMeters(r.meters + (r.offroad > 25 ? r.offroad : 0));
      $('#rp-eta').textContent = 'Arrive ' + fmtClock(new Date(Date.now() + r.seconds * 1000));
      setNote(r.offroad > 100 ? `The road route ends ${fmtMeters(r.offroad)} from the pin. The dashed line shows the rest of the way.` : '');
      $('#rp-steps').innerHTML = r.steps.map((s, i) =>
        `<li data-step="${i}">${arrowSVG(s.maneuver)}<span>${esc(s.text || 'Continue')}${s.meters ? `<span class="s-dist">${fmtMeters(s.meters)}</span>` : ''}</span></li>`
      ).join('') + `<li>${arrowSVG('ARRIVE')}<span>Arrive at ${esc(p.name)}${r.offroad > 100 ? `<span class="s-dist">The pin is ${fmtMeters(r.offroad)} past the end of the road route</span>` : ''}</span></li>`;
    }

    function drawRoute(fit) {
      clearLines();
      const r = route;
      lines = [
        new G.Polyline({ map, path: r.path, strokeColor: '#FFFFFF', strokeOpacity: 1, strokeWeight: 11, zIndex: 9, clickable: false }),
        new G.Polyline({ map, path: r.path, strokeColor: '#1A73E8', strokeOpacity: 1, strokeWeight: 7, zIndex: 10, clickable: false })
      ];
      if (r.offroad > 25) {
        offLine = new G.Polyline({
          map, path: [r.end, r.dest], strokeOpacity: 0, zIndex: 11, clickable: false,
          icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#1A73E8', strokeWeight: 4, scale: 3 }, offset: '0', repeat: '14px' }]
        });
      }
      if (fit) fitRoute();
    }
    function fitRoute() {
      if (!route || !map) return;
      const pts = route.path.concat([route.dest]);
      if (state.me) pts.push(state.me);
      const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng);
      const panelH = $('#route-panel').offsetHeight || 180;
      map.fitBounds(
        { north: Math.max(...lats), south: Math.min(...lats), east: Math.max(...lngs), west: Math.min(...lngs) },
        { top: 70, right: 72, bottom: panelH + 28, left: 28 }
      );
    }
    function clearLines() {
      lines.forEach(l => l.setMap(null));
      lines = [];
      if (offLine) { offLine.setMap(null); offLine = null; }
    }
    function clearRoute() {
      routeReq++;
      stopNav(true);
      clearLines();
      route = null;
      $('#route-panel').hidden = true;
      view.classList.remove('navigating');
      refreshCard();
    }

    /* live guidance */
    function speak(text) {
      if (!state.voice || !('speechSynthesis' in window) || !text) return;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-US';
        setTimeout(() => window.speechSynthesis.speak(u), 60);
      } catch (e) { /* speech unavailable */ }
    }
    async function keepAwake() {
      try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) { wake = null; }
    }
    function letSleep() { try { if (wake) wake.release(); } catch (e) { /* ignore */ } wake = null; }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && nav && !nav.arrived) keepAwake(); });

    function setSign(man, dist, text) {
      $('#nav-arrow').innerHTML = arrowSVG(man);
      $('#nav-dist').textContent = dist;
      $('#nav-text').textContent = text;
    }
    function syncVoiceBtn() {
      const b = $('#rp-voice');
      b.textContent = state.voice ? 'Voice on' : 'Voice off';
      b.setAttribute('aria-pressed', String(state.voice));
    }

    function startNav() {
      if (!route) return;
      nav = { follow: true, spoken: {}, off: 0, lastReroute: 0, arrived: false, lastAlong: null, lastStep: -2 };
      panelMode('nav');
      syncVoiceBtn();
      closeLayers();
      $('#locate-btn').classList.remove('attn');
      keepAwake();
      speak('Starting route to ' + spokenName(route.place.name) + '.');
      const first = route.steps[0];
      setSign(first ? first.maneuver : 'STRAIGHT', fmtMeters(route.track.total), first && first.text ? first.text : 'Follow the route');
      if (map) map.setZoom(16);
      if (state.me) navUpdate(state.me);
    }
    function stopNav(silent) {
      if (!nav) return;
      nav = null;
      letSleep();
      view.classList.remove('navigating');
      document.body.classList.remove('nav-on');
      $('#nav-sign').hidden = true;
      $('#locate-btn').classList.remove('attn');
      if (!silent && route) { panelMode('ready'); showRouteInfo(); fitRoute(); }
    }

    function voiceFor(i, toMan, text) {
      if (!state.voice || !text) return;
      const sp = nav.spoken[i] || (nav.spoken[i] = {});
      if (toMan <= 160) { if (!sp.now) { sp.now = sp.far = true; speak(text); } }
      else if (toMan <= 900 && toMan >= 350 && !sp.far) { sp.far = true; speak(`In ${spokenDist(toMan)}, ${lowerFirst(text)}`); }
    }

    function navUpdate(me) {
      const r = route;
      if (!r || !nav) return;
      const prog = progress(r, me, nav.lastAlong);
      nav.lastAlong = prog.along;

      // Off route? Reroute after a few bad fixes, at most every 20 seconds.
      const limit = Math.max(80, (me.acc || 0) * 1.5);
      nav.off = prog.offM > limit ? nav.off + 1 : 0;
      if (nav.off >= 3 && !nav.arrived && Date.now() - nav.lastReroute > 20000) { reroute(); return; }

      const remaining = Math.max(0, r.track.total - prog.along);
      const toDest = meters(me, r.dest);
      const atRoadEnd = remaining < 40;

      if (!nav.arrived && (toDest < 60 || (atRoadEnd && r.offroad < 100))) {
        nav.arrived = true;
        setSign('ARRIVE', 'Arrived', r.place.name);
        speak('You have arrived at ' + spokenName(r.place.name) + '.');
        letSleep();
      } else if (!nav.arrived && atRoadEnd) {
        const dir = DIR_LONG[dirIdx(bearing(me, r.dest))];
        setSign('ARRIVE', fmtMeters(toDest), `Road route ends. Pin is to the ${dir}`);
        if (!nav.spoken.roadEnd) { nav.spoken.roadEnd = true; speak(`The road route ends here. The pin is ${spokenDist(toDest)} to the ${dir}.`); }
      } else if (!nav.arrived) {
        const s = prog.step;
        if (r.hasSteps && s >= 0) {
          const next = r.steps[s + 1];
          const toMan = Math.max(0, r.stepEnd[s] - prog.along);
          if (next) { setSign(next.maneuver, fmtMeters(toMan), next.text || 'Continue'); voiceFor(s + 1, toMan, next.text); }
          else setSign('ARRIVE', fmtMeters(remaining + (r.offroad > 25 ? r.offroad : 0)), 'Arrive at ' + r.place.name);
          if (s !== nav.lastStep) {
            nav.lastStep = s;
            $$('#rp-steps li').forEach(li => li.classList.toggle('now', li.dataset.step === String(s + 1)));
          }
        } else {
          setSign('STRAIGHT', fmtMeters(remaining), 'Follow the blue line to ' + r.place.name);
        }
      }

      const frac = r.track.total ? remaining / r.track.total : 0;
      const secs = r.seconds * frac;
      $('#rp-time').textContent = nav.arrived ? 'Arrived' : fmtDuration(secs);
      $('#rp-dist').textContent = fmtMeters(remaining + (r.offroad > 25 ? r.offroad : 0));
      $('#rp-eta').textContent = nav.arrived ? '' : 'Arrive ' + fmtClock(new Date(Date.now() + secs * 1000));
      if (nav.follow && map) map.panTo({ lat: me.lat, lng: me.lng });
    }

    async function reroute() {
      nav.lastReroute = Date.now();
      nav.off = 0;
      toast('Rerouting');
      speak('Rerouting.');
      const p = route.place;
      try {
        const r = await computeRoute({ lat: state.me.lat, lng: state.me.lng }, p);
        if (!nav || !route || route.place !== p) return;
        r.place = p;
        route = r;
        nav.spoken = {};
        nav.lastAlong = null;
        nav.lastStep = -2;
        drawRoute(false);
        showRouteInfo();
        navUpdate(state.me);
      } catch (e) {
        toast('Couldn’t reroute yet. It will try again.');
      }
    }

    /* wire map controls */
    $('#layers-btn').addEventListener('click', () => toggleLayers());
    $$('.layer-grid button').forEach(b => b.addEventListener('click', () => setMapType(b.dataset.type)));
    $('#traffic').addEventListener('change', e => setTraffic(e.target.checked));
    $('#labels').addEventListener('change', e => setLabels(e.target.checked));
    $('#locate-btn').addEventListener('click', locate);
    $('#mc-details').addEventListener('click', () => { if (sel) openPlace(sel.i); });
    $('#mc-route').addEventListener('click', () => { if (sel) routeTo(sel); });
    $('#rp-close').addEventListener('click', clearRoute);
    $('#rp-start').addEventListener('click', startNav);
    $('#rp-end').addEventListener('click', () => stopNav(false));
    $('#rp-retry').addEventListener('click', () => { if (retryTarget) routeTo(retryTarget); });
    $('#rp-voice').addEventListener('click', () => {
      state.voice = !state.voice; store.set('voice', state.voice); syncVoiceBtn();
      if (!state.voice && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    });
    $('#rp-steps-btn').addEventListener('click', () => {
      const list = $('#rp-steps');
      list.hidden = !list.hidden;
      $('#rp-steps-btn').setAttribute('aria-expanded', String(!list.hidden));
      $('#rp-steps-btn').textContent = list.hidden ? 'Steps' : 'Hide steps';
    });
    syncLayerUI();

    return {
      show, onPosition, routeTo,
      focusMe: () => { setTab('map'); init().then(locate).catch(() => {}); },
      showOnMap: p => { setTab('map'); init().then(() => { if (!route) select(p, true); else map.panTo({ lat: p.lat, lng: p.lng }); }).catch(() => {}); }
    };
  })();

  /* ---------------- wire up ---------------- */
  // operator filter
  $('#op').innerHTML = `<option value="">All operators</option>` +
    operators.map(o => `<option value="${esc(o)}">${esc(o)} (${places.filter(p => p.op === o).length})</option>`).join('') +
    `<option value="__none">No operator listed (${places.filter(p => !p.op).length})</option>`;
  $('#op').addEventListener('change', e => {
    const v = e.target.value;
    state.op = v === '__none' ? '' : v;
    state.noOp = v === '__none';
    renderList();
  });
  let qTimer = null;
  $('#q').addEventListener('input', e => {
    state.q = e.target.value.trim();
    $('#q-clear').hidden = !e.target.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(renderList, 60);
  });
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  $('#q-clear').addEventListener('click', () => { $('#q').value = ''; state.q = ''; $('#q-clear').hidden = true; renderList(); $('#q').focus(); });
  $('#empty-clear').addEventListener('click', () => {
    $('#q').value = ''; state.q = ''; $('#q-clear').hidden = true;
    $('#op').value = ''; state.op = ''; state.noOp = false;
    renderList();
  });
  $$('.seg button').forEach(b => b.addEventListener('click', () => {
    state.sort = b.dataset.sort;
    syncSort();
    if (state.sort === 'near' && !state.me) { startGps(); toast('Finding your location…'); }
    renderList();
  }));
  // hide the keyboard when the driver starts scrolling the list
  $('#view-list').addEventListener('touchstart', e => { if (!e.target.closest('.controls') && document.activeElement === $('#q')) $('#q').blur(); }, { passive: true });

  const openFromRow = e => { const b = e.target.closest('.row'); if (b) openPlace(+b.dataset.i); };
  $('#rows').addEventListener('click', openFromRow);
  $('#saved').addEventListener('click', openFromRow);

  $('#loc-btn').addEventListener('click', startGps);
  $('#gps').addEventListener('click', () => {
    if (state.gps === 'on') MapView.focusMe();
    else if (state.gps === 'denied') toast('Location is blocked. Allow it in Settings for Crude Maps.');
    else startGps();
  });

  $('#install').addEventListener('click', async e => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'install' && installEvt) {
      installEvt.prompt();
      try { await installEvt.userChoice; } catch (err) { /* ignore */ }
      installEvt = null;
    } else if (act.dataset.act === 'dismiss') {
      store.set('installDismissed', true);
    }
    renderInstall();
  });

  $$('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // sheet
  scrim.addEventListener('click', closeSheet);
  $('#d-close').addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetOpen) closeSheet(); });
  $('#d-star').addEventListener('click', () => { if (sheetP) toggleFav(sheetP); });
  $('#d-route').addEventListener('click', () => { const p = sheetP; closeSheet(); if (p) MapView.routeTo(p); });
  $('#d-map').addEventListener('click', () => { const p = sheetP; closeSheet(); if (p) MapView.showOnMap(p); });
  $('#d-copy').addEventListener('click', async () => {
    if (!sheetP) return;
    toast(await copyText(`${sheetP.lat.toFixed(6)}, ${sheetP.lng.toFixed(6)}`) ? 'Coordinates copied' : 'Couldn’t copy. Press and hold the numbers instead.');
  });
  $('#d-share').addEventListener('click', async () => {
    const p = sheetP;
    if (!p) return;
    const url = navUrl.share(p);
    const text = p.op ? `${p.name} (${p.op})` : p.name;
    if (navigator.share) {
      try { await navigator.share({ title: p.name, text, url }); } catch (e) { /* cancelled */ }
    } else {
      toast(await copyText(`${text}\n${url}`) ? 'Link copied' : 'Couldn’t copy the link');
    }
  });

  // start
  syncSort();
  setGps('off');
  renderList();
  renderInstall();
  if (store.get('gpsOK', false)) startGps();
  else if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then(r => {
      if (r.state === 'granted') startGps();
      else if (r.state === 'denied') setGps('denied');
    }).catch(() => { /* not supported */ });
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(err => console.warn('[Crude Maps] offline mode unavailable', err)); });
  }

  // exposed for testing in the browser console
  window.CrudeMaps = { finishRoute, progress, fromRouteClass, fromDirections, arrowSVG, fmtMiles, spokenDist, places };
})();
