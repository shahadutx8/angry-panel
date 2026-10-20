'use strict';
/*
 * ANGRY MOD — Panel & Auth Server (original code, built for com.angry.mod)
 *
 * Implements the exact protocol the ANGRY MOD v3.0 APK speaks (recovered
 * from libUtility.so nativeLogin):
 *   POST /connect   form fields: user_key, serial (secret/game ignored)
 *     success -> {"status":true, "data":{"user_key":..., "expired_date":...,
 *                  "registrator":..., "seller_name":...}}
 *     failure -> {"status":false, "reason":"..."}   (optional "crash":true)
 *   GET  /connect   -> {"web_info": {...}, "web__dev": {...}}
 *   GET  /update.php  -> update info JSON (latest version / url / message)
 *   GET  /apkhash.php -> plain-text MD5 hash of the official APK
 *
 * Admin panel: /login -> /dashboard (keys, settings, login logs)
 * No external dependencies: node:http + node:sqlite only (Node >= 22.5).
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'panel.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT UNIQUE NOT NULL,
  label TEXT DEFAULT '',
  seller_name TEXT DEFAULT 'ANGRY MOD',
  registrator TEXT DEFAULT 'Admin',
  expired_date TEXT NOT NULL,
  serial TEXT,
  status TEXT DEFAULT 'active',       -- active | banned | crash
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  user_key TEXT, serial TEXT, ip TEXT, result TEXT, reason TEXT
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
`);

function getSetting(k, dflt) {
  const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k);
  return r ? r.v : dflt;
}
function setSetting(k, v) {
  db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
}
// Seed defaults (only when empty)
if (!getSetting('apk_md5')) setSetting('apk_md5', 'becb3c8f75961ed77368896e9325ece4'); // MD5 of ANGRY_MOD_V3 as uploaded 2026-10-20
if (!getSetting('latest_version')) setSetting('latest_version', '3.0');
if (!getSetting('latest_version_code')) setSetting('latest_version_code', '1');
if (!getSetting('update_url')) setSetting('update_url', '');
if (!getSetting('update_message')) setSetting('update_message', '');
if (!getSetting('client_name')) setSetting('client_name', 'ANGRY MOD');
if (!getSetting('panel_license')) setSetting('panel_license', crypto.randomBytes(16).toString('hex'));
if (!getSetting('dev_author')) setSetting('dev_author', '@engpinxt');
if (!getSetting('dev_telegram')) setSetting('dev_telegram', 'https://t.me/angrymodofficials');
if (!getSetting('crash_all')) setSetting('crash_all', '0');
if (!getSetting('crash_message')) setSetting('crash_message', 'Server is under maintenance');

/* ---------------- admin auth ---------------- */
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
let ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_PASS) {
  ADMIN_PASS = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, 'A');
  console.log('==================================================');
  console.log(' ADMIN_PASS was not set in environment.');
  console.log(' Generated admin password (save it NOW): ' + ADMIN_PASS);
  console.log(' Admin username: ' + ADMIN_USER);
  console.log('==================================================');
}
const passHash = crypto.scryptSync(ADMIN_PASS, 'angry-panel-salt', 32);
const sessions = new Map(); // sid -> {user, exp}
function isAuthed(req) {
  const m = (req.headers.cookie || '').match(/sid=([a-f0-9]+)/);
  if (!m) return false;
  const s = sessions.get(m[1]);
  if (!s || s.exp < Date.now()) return false;
  return true;
}

/* ---------------- helpers ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=UTF-8' });
  res.end(body);
}
function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=UTF-8' });
  res.end(html);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
  });
}
function parseFields(req, raw) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) { try { return JSON.parse(raw || '{}'); } catch { return {}; } }
  const out = {};
  for (const [k, v] of new URLSearchParams(raw || '')) out[k] = v;
  return out;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function genKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = (n) => Array.from(crypto.randomBytes(n)).map((b) => chars[b % chars.length]).join('');
  return 'ANGRY-' + seg(4) + '-' + seg(4) + '-' + seg(4);
}
function logAttempt(req, f, result, reason) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  db.prepare('INSERT INTO logs(user_key,serial,ip,result,reason) VALUES(?,?,?,?,?)')
    .run(f.user_key || '', f.serial || '', ip, result, reason || '');
}

/* ---------------- APK protocol ---------------- */
function handleConnectGet(res) {
  sendJson(res, 200, {
    web_info: {
      _client: getSetting('client_name'),
      license: getSetting('panel_license'),
      version: '1.0.0',
    },
    web__dev: {
      author: getSetting('dev_author'),
      telegram: getSetting('dev_telegram'),
    },
  });
}

async function handleConnectPost(req, res) {
  const raw = await readBody(req);
  const f = parseFields(req, raw);
  const userKey = String(f.user_key || '').trim();
  const serial = String(f.serial || '').trim();

  if (getSetting('crash_all') === '1') {
    logAttempt(req, f, 'crash', 'crash_all');
    return sendJson(res, 200, { status: false, crash: true, reason: getSetting('crash_message') });
  }
  if (!userKey) {
    logAttempt(req, f, 'fail', 'User key required');
    return sendJson(res, 200, { status: false, reason: 'User key required' });
  }
  const row = db.prepare('SELECT * FROM keys WHERE user_key=?').get(userKey);
  if (!row) {
    logAttempt(req, f, 'fail', 'Invalid user key');
    return sendJson(res, 200, { status: false, reason: 'Invalid user key' });
  }
  if (row.status === 'banned') {
    logAttempt(req, f, 'fail', 'Key banned');
    return sendJson(res, 200, { status: false, reason: 'This key is banned. Contact your seller.' });
  }
  if (row.status === 'crash') {
    logAttempt(req, f, 'crash', 'Key crash flag');
    return sendJson(res, 200, { status: false, crash: true, reason: 'This key has been disabled by admin.' });
  }
  if (new Date(row.expired_date.replace(' ', 'T')) < new Date()) {
    logAttempt(req, f, 'fail', 'Key expired');
    return sendJson(res, 200, { status: false, reason: 'Your key has expired. Contact your seller.' });
  }
  if (serial) {
    if (!row.serial) {
      db.prepare('UPDATE keys SET serial=? WHERE id=?').run(serial, row.id);
    } else if (row.serial !== serial) {
      logAttempt(req, f, 'fail', 'Serial mismatch');
      return sendJson(res, 200, { status: false, reason: 'Serial not matched. This key is used on another device.' });
    }
  }
  logAttempt(req, f, 'success', '');
  return sendJson(res, 200, {
    status: true,
    data: {
      user_key: row.user_key,
      expired_date: row.expired_date,
      registrator: row.registrator || 'Admin',
      seller_name: row.seller_name || 'ANGRY MOD',
    },
  });
}

function handleUpdate(res, url) {
  const latest = getSetting('latest_version');
  const latestCode = parseInt(getSetting('latest_version_code'), 10) || 1;
  const clientCode = parseInt(url.searchParams.get('version_code') || url.searchParams.get('code') || '0', 10) || 0;
  const updateAvailable = clientCode > 0 ? clientCode < latestCode : false;
  sendJson(res, 200, {
    status: true,
    version: latest,
    version_code: latestCode,
    update_available: updateAvailable,
    url: updateAvailable ? getSetting('update_url') : '',
    message: updateAvailable
      ? (getSetting('update_message') || 'A new version is available. Please update.')
      : 'You are using the latest version',
  });
}

/* ---------------- admin UI ---------------- */
const page = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{background:#0b0b10;color:#e8e8ef;font-family:system-ui,sans-serif;margin:0;padding:20px}
a{color:#ff5252}h1,h2{color:#ff5252}.card{background:#15151d;border:1px solid #262633;border-radius:10px;padding:16px;margin:14px 0}
input,select,button{background:#1d1d28;color:#fff;border:1px solid #333344;border-radius:6px;padding:8px;margin:4px 0}
button{background:#c62828;border:none;cursor:pointer;padding:8px 14px}button.gray{background:#333344}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid #262633;padding:6px;text-align:left}
.ok{color:#69f0ae}.bad{color:#ff8a80}.small{font-size:12px;color:#999}</style></head>
<body>${inner}</body></html>`;

function loginPage(err) {
  return page('ANGRY MOD - Login', `<h1>ANGRY MOD - Panel Login</h1>
  ${err ? '<p class="bad">' + esc(err) + '</p>' : ''}
  <form method="post" action="/login" class="card">
    <div><input name="username" placeholder="Enter your username" required></div>
    <div><input name="password" type="password" placeholder="Enter your password" required></div>
    <button>Login</button>
  </form>`);
}

function dashboardPage() {
  const keys = db.prepare('SELECT * FROM keys ORDER BY id DESC').all();
  const logs = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 50').all();
  const rows = keys.map((k) => `<tr><td>${k.id}</td><td><b>${esc(k.user_key)}</b><br><span class="small">${esc(k.label)}</span></td>
    <td>${esc(k.expired_date)}</td><td>${esc(k.serial || '-')}</td>
    <td class="${k.status === 'active' ? 'ok' : 'bad'}">${esc(k.status)}</td>
    <td>${esc(k.seller_name)} / ${esc(k.registrator)}</td>
    <td>
      <form method="post" action="/api/keys/${k.id}/action" style="display:inline">
        <select name="act"><option value="unbind">Unbind serial</option><option value="ban">Ban</option>
        <option value="unban">Unban</option><option value="crash">Crash</option><option value="delete">Delete</option></select>
        <button class="gray">Go</button></form>
    </td></tr>`).join('');
  const logRows = logs.map((l) => `<tr><td>${esc(l.ts)}</td><td>${esc(l.user_key)}</td><td>${esc(l.serial)}</td>
    <td>${esc(l.ip)}</td><td class="${l.result === 'success' ? 'ok' : 'bad'}">${esc(l.result)}</td><td>${esc(l.reason)}</td></tr>`).join('');
  return page('ANGRY MOD - Dashboard', `<h1>ANGRY MOD - Dashboard</h1>
  <p><a href="/logout">Logout</a></p>
  <div class="card"><h2>Create key</h2>
    <form method="post" action="/api/keys">
      <input name="user_key" placeholder="Custom key (blank = auto-generate)">
      <input name="label" placeholder="Label / buyer name">
      <input name="days" type="number" value="30" min="1" style="width:90px"> days
      <input name="seller_name" placeholder="Seller name" value="ANGRY MOD">
      <input name="registrator" placeholder="Registrator" value="Admin">
      <button>Create</button>
    </form></div>
  <div class="card"><h2>Keys (${keys.length})</h2><table>
    <tr><th>#</th><th>Key</th><th>Expiry</th><th>Serial</th><th>Status</th><th>Seller/By</th><th>Action</th></tr>${rows}</table></div>
  <div class="card"><h2>Settings</h2>
    <form method="post" action="/api/settings">
      <div>Latest version <input name="latest_version" value="${esc(getSetting('latest_version'))}">
      code <input name="latest_version_code" value="${esc(getSetting('latest_version_code'))}" style="width:70px"></div>
      <div>Update APK URL <input name="update_url" value="${esc(getSetting('update_url'))}" style="width:70%"></div>
      <div>Update message <input name="update_message" value="${esc(getSetting('update_message'))}" style="width:70%"></div>
      <div>Official APK MD5 <input name="apk_md5" value="${esc(getSetting('apk_md5'))}" style="width:300px"></div>
      <div>Crash ALL users <select name="crash_all"><option value="0"${getSetting('crash_all') === '0' ? ' selected' : ''}>Off</option><option value="1"${getSetting('crash_all') === '1' ? ' selected' : ''}>On</option></select>
      message <input name="crash_message" value="${esc(getSetting('crash_message'))}"></div>
      <button>Save settings</button>
    </form>
    <p class="small">APK endpoints: POST /connect &nbsp; GET /update.php &nbsp; GET /apkhash.php</p></div>
  <div class="card"><h2>Login logs (last 50)</h2><table>
    <tr><th>Time</th><th>Key</th><th>Serial</th><th>IP</th><th>Result</th><th>Reason</th></tr>${logRows}</table></div>`);
}

/* ---------------- router ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p !== '/healthz') console.log('[REQ]', req.method, req.url);
    if (p === '/hdshrs.php' || p === '/hdshrs') {
      const body = await readBody(req).catch(() => '');
      console.log('[HDSHRS]', req.method, 'body:', String(body).slice(0, 500));
      return sendJson(res, 200, { status: true });
    }
    if (p === '/connect' && req.method === 'GET') return handleConnectGet(res);
    if (p === '/connect' && req.method === 'POST') return await handleConnectPost(req, res);
    if (p === '/update.php' || p === '/update') return handleUpdate(res, url);
    if (p === '/apkhash.php' || p === '/apkhash') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
      return res.end(getSetting('apk_md5'));
    }
    if (p === '/' || p === '/login') {
      if (isAuthed(req)) { res.writeHead(302, { Location: '/dashboard' }); return res.end(); }
      if (req.method === 'POST') {
        const f = parseFields(req, await readBody(req));
        const okUser = f.username === ADMIN_USER;
        const given = crypto.scryptSync(String(f.password || ''), 'angry-panel-salt', 32);
        if (okUser && crypto.timingSafeEqual(given, passHash)) {
          const sid = crypto.randomBytes(24).toString('hex');
          sessions.set(sid, { user: ADMIN_USER, exp: Date.now() + 7 * 864e5 });
          res.writeHead(302, { 'Set-Cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`, Location: '/dashboard' });
          return res.end();
        }
        return sendHtml(res, 200, loginPage('Wrong username or password'));
      }
      return sendHtml(res, 200, loginPage(''));
    }
    if (p === '/logout') {
      res.writeHead(302, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/', Location: '/login' });
      return res.end();
    }
    if (p === '/dashboard') {
      if (!isAuthed(req)) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return sendHtml(res, 200, dashboardPage());
    }
    if (p === '/api/keys' && req.method === 'POST') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: 'login required' });
      const f = parseFields(req, await readBody(req));
      const key = String(f.user_key || '').trim() || genKey();
      const days = Math.max(1, parseInt(f.days, 10) || 30);
      const exp = new Date(Date.now() + days * 864e5).toISOString().slice(0, 19).replace('T', ' ');
      try {
        db.prepare('INSERT INTO keys(user_key,label,seller_name,registrator,expired_date) VALUES(?,?,?,?,?)')
          .run(key, f.label || '', f.seller_name || 'ANGRY MOD', f.registrator || 'Admin', exp);
      } catch (e) { return sendHtml(res, 400, page('Error', '<p class="bad">Key already exists</p><p><a href="/dashboard">Back</a></p>')); }
      res.writeHead(302, { Location: '/dashboard' }); return res.end();
    }
    const m = p.match(/^\/api\/keys\/(\d+)\/action$/);
    if (m && req.method === 'POST') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: 'login required' });
      const f = parseFields(req, await readBody(req));
      const id = parseInt(m[1], 10);
      if (f.act === 'unbind') db.prepare('UPDATE keys SET serial=NULL WHERE id=?').run(id);
      else if (f.act === 'ban') db.prepare("UPDATE keys SET status='banned' WHERE id=?").run(id);
      else if (f.act === 'unban') db.prepare("UPDATE keys SET status='active' WHERE id=?").run(id);
      else if (f.act === 'crash') db.prepare("UPDATE keys SET status='crash' WHERE id=?").run(id);
      else if (f.act === 'delete') db.prepare('DELETE FROM keys WHERE id=?').run(id);
      res.writeHead(302, { Location: '/dashboard' }); return res.end();
    }
    if (p === '/api/settings' && req.method === 'POST') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: 'login required' });
      const f = parseFields(req, await readBody(req));
      for (const k of ['latest_version', 'latest_version_code', 'update_url', 'update_message', 'apk_md5', 'crash_all', 'crash_message']) {
        if (f[k] !== undefined) setSetting(k, f[k]);
      }
      res.writeHead(302, { Location: '/dashboard' }); return res.end();
    }
    if (p === '/healthz') return sendJson(res, 200, { name: 'angry-panel', version: '1.0.0', ok: true });
    res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ status: false, reason: 'Not found' }));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { status: false, reason: 'Server error' });
  }
});

server.listen(PORT, () => console.log('angry-panel listening on port ' + PORT));
