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
 *
 * Storage: Postgres when DATABASE_URL is set (persistent — survives
 * restarts/redeploys), otherwise local SQLite file (dev fallback).
 * Keys support max_devices: 1 = single device (default), 0 = UNLIMITED.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_PG = !!DATABASE_URL;

/* ---------------- storage layer (pg or sqlite, same API) ---------------- */
let dbRun, dbGet, dbAll, dbKind;
if (USE_PG) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /neon\.tech|render\.com/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
  const conv = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
  dbKind = 'postgres';
  dbRun = async (sql, ...p) => { await pool.query(conv(sql), p); };
  dbGet = async (sql, ...p) => { const r = await pool.query(conv(sql), p); return r.rows[0]; };
  dbAll = async (sql, ...p) => { const r = await pool.query(conv(sql), p); return r.rows; };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const sq = new DatabaseSync(path.join(DATA_DIR, 'panel.db'));
  dbKind = 'sqlite';
  dbRun = async (sql, ...p) => { sq.prepare(sql).run(...p); };
  dbGet = async (sql, ...p) => sq.prepare(sql).get(...p);
  dbAll = async (sql, ...p) => sq.prepare(sql).all(...p);
}

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

async function initDb() {
  if (USE_PG) {
    await dbRun(`CREATE TABLE IF NOT EXISTS keys (
      id SERIAL PRIMARY KEY,
      user_key TEXT UNIQUE NOT NULL,
      label TEXT DEFAULT '',
      seller_name TEXT DEFAULT 'ANGRY MOD',
      registrator TEXT DEFAULT 'Admin',
      expired_date TEXT NOT NULL,
      serial TEXT,
      max_devices INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT '')`);
    await dbRun(`CREATE TABLE IF NOT EXISTS key_devices (
      id SERIAL PRIMARY KEY,
      key_id INTEGER NOT NULL,
      serial TEXT NOT NULL,
      first_seen TEXT DEFAULT '',
      UNIQUE(key_id, serial))`);
    await dbRun(`CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TEXT DEFAULT '',
      user_key TEXT, serial TEXT, ip TEXT, result TEXT, reason TEXT)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`);
    await dbRun(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS max_devices INTEGER DEFAULT 1`);
  } else {
    await dbRun(`CREATE TABLE IF NOT EXISTS keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT UNIQUE NOT NULL,
      label TEXT DEFAULT '',
      seller_name TEXT DEFAULT 'ANGRY MOD',
      registrator TEXT DEFAULT 'Admin',
      expired_date TEXT NOT NULL,
      serial TEXT,
      max_devices INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT '')`);
    await dbRun(`CREATE TABLE IF NOT EXISTS key_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id INTEGER NOT NULL,
      serial TEXT NOT NULL,
      first_seen TEXT DEFAULT '',
      UNIQUE(key_id, serial))`);
    await dbRun(`CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT '',
      user_key TEXT, serial TEXT, ip TEXT, result TEXT, reason TEXT)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`);
    const cols = await dbAll(`PRAGMA table_info(keys)`);
    if (!cols.some((c) => c.name === 'max_devices')) {
      await dbRun(`ALTER TABLE keys ADD COLUMN max_devices INTEGER DEFAULT 1`);
    }
  }
  // Migrate any legacy single-serial binding into key_devices
  const legacy = await dbAll(`SELECT id, serial FROM keys WHERE serial IS NOT NULL AND serial<>''`);
  for (const k of legacy) {
    const has = await dbGet(`SELECT id FROM key_devices WHERE key_id=? AND serial=?`, k.id, k.serial);
    if (!has) await dbRun(`INSERT INTO key_devices(key_id,serial,first_seen) VALUES(?,?,?)`, k.id, k.serial, nowSql()).catch(() => {});
  }
  // Seed defaults (only when empty)
  if (!(await getSetting('apk_md5'))) await setSetting('apk_md5', 'becb3c8f75961ed77368896e9325ece4'); // MD5 of ANGRY_MOD_V3 as uploaded 2026-10-20
  if (!(await getSetting('latest_version'))) await setSetting('latest_version', '3.0');
  if (!(await getSetting('latest_version_code'))) await setSetting('latest_version_code', '1');
  if (!(await getSetting('update_url'))) await setSetting('update_url', '');
  if (!(await getSetting('update_message'))) await setSetting('update_message', '');
  if (!(await getSetting('client_name'))) await setSetting('client_name', 'ANGRY MOD');
  if (!(await getSetting('panel_license'))) await setSetting('panel_license', crypto.randomBytes(16).toString('hex'));
  if (!(await getSetting('dev_author'))) await setSetting('dev_author', '@engpinxt');
  if (!(await getSetting('dev_telegram'))) await setSetting('dev_telegram', 'https://t.me/angrymodofficials');
  if (!(await getSetting('crash_all'))) await setSetting('crash_all', '0');
  if (!(await getSetting('crash_message'))) await setSetting('crash_message', 'Server is under maintenance');
  if (!(await getSetting('expired_link'))) await setSetting('expired_link', '');
}

async function getSetting(k) {
  const r = await dbGet('SELECT v FROM settings WHERE k=?', k);
  return r ? r.v : null;
}
async function setSetting(k, v) {
  await dbRun('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v));
}
async function listDevices(keyId) {
  const rows = await dbAll('SELECT serial FROM key_devices WHERE key_id=? ORDER BY id', keyId);
  return rows.map((r) => r.serial);
}

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
async function logAttempt(req, f, result, reason) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  await dbRun('INSERT INTO logs(ts,user_key,serial,ip,result,reason) VALUES(?,?,?,?,?,?)',
    nowSql(), f.user_key || '', f.serial || '', ip, result, reason || '').catch(() => {});
}

/* ---------------- APK protocol ---------------- */
async function handleConnectGet(res) {
  sendJson(res, 200, {
    web_info: {
      _client: await getSetting('client_name'),
      license: await getSetting('panel_license'),
      version: '1.0.0',
    },
    web__dev: {
      author: await getSetting('dev_author'),
      telegram: await getSetting('dev_telegram'),
    },
  });
}

async function handleConnectPost(req, res) {
  const raw = await readBody(req);
  const f = parseFields(req, raw);
  const userKey = String(f.user_key || '').trim();
  const serial = String(f.serial || '').trim();

  if ((await getSetting('crash_all')) === '1') {
    await logAttempt(req, f, 'crash', 'crash_all');
    return sendJson(res, 200, { status: false, crash: true, reason: await getSetting('crash_message') });
  }
  if (!userKey) {
    await logAttempt(req, f, 'fail', 'User key required');
    return sendJson(res, 200, { status: false, reason: 'User key required' });
  }
  const row = await dbGet('SELECT * FROM keys WHERE user_key=?', userKey);
  if (!row) {
    await logAttempt(req, f, 'fail', 'Invalid user key');
    return sendJson(res, 200, { status: false, reason: 'Invalid user key' });
  }
  if (row.status === 'banned') {
    await logAttempt(req, f, 'fail', 'Key banned');
    return sendJson(res, 200, { status: false, reason: 'This key is banned. Contact your seller.' });
  }
  if (row.status === 'crash') {
    await logAttempt(req, f, 'crash', 'Key crash flag');
    return sendJson(res, 200, { status: false, crash: true, reason: 'This key has been disabled by admin.' });
  }
  if (new Date(row.expired_date.replace(' ', 'T')) < new Date()) {
    await logAttempt(req, f, 'fail', 'Key expired');
    const expLink = (await getSetting('expired_link')) || '';
    const reason = expLink
      ? 'Your key has expired. Renew / new key: ' + expLink
      : 'Your key has expired. Contact your seller.';
    return sendJson(res, 200, { status: false, reason });
  }
  if (serial) {
    const maxDev = (row.max_devices == null ? 1 : row.max_devices); // 0 = unlimited
    const devices = await listDevices(row.id);
    if (!devices.includes(serial)) {
      if (maxDev !== 0 && devices.length >= maxDev) {
        await logAttempt(req, f, 'fail', 'Device limit reached');
        return sendJson(res, 200, { status: false, reason: 'Device limit reached. This key is already used on the maximum number of devices.' });
      }
      await dbRun('INSERT INTO key_devices(key_id,serial,first_seen) VALUES(?,?,?)', row.id, serial, nowSql()).catch(() => {});
      if (!row.serial) await dbRun('UPDATE keys SET serial=? WHERE id=?', serial, row.id).catch(() => {});
    }
  }
  await logAttempt(req, f, 'success', '');
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

async function handleUpdate(res, url) {
  const latest = await getSetting('latest_version');
  const latestCode = parseInt(await getSetting('latest_version_code'), 10) || 1;
  const clientCode = parseInt(url.searchParams.get('version_code') || url.searchParams.get('code') || '0', 10) || 0;
  const updateAvailable = clientCode > 0 ? clientCode < latestCode : false;
  sendJson(res, 200, {
    status: true,
    version: latest,
    version_code: latestCode,
    update_available: updateAvailable,
    url: updateAvailable ? await getSetting('update_url') : '',
    message: updateAvailable
      ? ((await getSetting('update_message')) || 'A new version is available. Please update.')
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

async function dashboardPage() {
  const keys = await dbAll('SELECT * FROM keys ORDER BY id DESC');
  const logs = await dbAll('SELECT * FROM logs ORDER BY id DESC LIMIT 50');
  const rows = [];
  for (const k of keys) {
    const devices = await listDevices(k.id);
    const maxDev = (k.max_devices == null ? 1 : k.max_devices);
    const devText = maxDev === 0 ? devices.length + ' / Unlimited' : devices.length + ' / ' + maxDev;
    const devList = devices.length ? '<br><span class="small">' + devices.map(esc).join('<br>') + '</span>' : '';
    rows.push(`<tr><td>${k.id}</td><td><b>${esc(k.user_key)}</b><br><span class="small">${esc(k.label)}</span></td>
    <td>${esc(k.expired_date)}</td><td>${devText}${devList}</td>
    <td class="${k.status === 'active' ? 'ok' : 'bad'}">${esc(k.status)}</td>
    <td>${esc(k.seller_name)} / ${esc(k.registrator)}</td>
    <td>
      <form method="post" action="/api/keys/${k.id}/action" style="display:inline">
        <select name="act"><option value="unbind">Unbind devices</option><option value="ban">Ban</option>
        <option value="unban">Unban</option><option value="crash">Crash</option><option value="delete">Delete</option></select>
        <button class="gray">Go</button></form>
    </td></tr>`);
  }
  const logRows = logs.map((l) => `<tr><td>${esc(l.ts)}</td><td>${esc(l.user_key)}</td><td>${esc(l.serial)}</td>
    <td>${esc(l.ip)}</td><td class="${l.result === 'success' ? 'ok' : 'bad'}">${esc(l.result)}</td><td>${esc(l.reason)}</td></tr>`).join('');
  const s = {};
  for (const k of ['latest_version', 'latest_version_code', 'update_url', 'update_message', 'apk_md5', 'crash_all', 'crash_message', 'expired_link']) s[k] = await getSetting(k);
  return page('ANGRY MOD - Dashboard', `<h1>ANGRY MOD - Dashboard</h1>
  <p><a href="/logout">Logout</a></p>
  <div class="card"><h2>Create key</h2>
    <form method="post" action="/api/keys">
      <input name="user_key" placeholder="Custom key (blank = auto-generate)">
      <input name="label" placeholder="Label / buyer name">
      <input name="days" type="number" value="30" min="1" style="width:90px"> days
      <select name="max_devices"><option value="1">1 device</option><option value="2">2 devices</option><option value="3">3 devices</option><option value="5">5 devices</option><option value="10">10 devices</option><option value="0">Unlimited devices</option></select>
      <input name="seller_name" placeholder="Seller name" value="ANGRY MOD">
      <input name="registrator" placeholder="Registrator" value="Admin">
      <button>Create</button>
    </form></div>
  <div class="card"><h2>Keys (${keys.length})</h2><table>
    <tr><th>#</th><th>Key</th><th>Expiry</th><th>Devices</th><th>Status</th><th>Seller/By</th><th>Action</th></tr>${rows.join('')}</table></div>
  <div class="card"><h2>Settings</h2>
    <form method="post" action="/api/settings">
      <div>Latest version <input name="latest_version" value="${esc(s.latest_version)}">
      code <input name="latest_version_code" value="${esc(s.latest_version_code)}" style="width:70px"></div>
      <div>Update APK URL <input name="update_url" value="${esc(s.update_url)}" style="width:70%"></div>
      <div>Update message <input name="update_message" value="${esc(s.update_message)}" style="width:70%"></div>
      <div>Expired-key Telegram link <input name="expired_link" value="${esc(s.expired_link)}" style="width:70%" placeholder="https://t.me/yourchannel"></div>
      <div>Official APK MD5 <input name="apk_md5" value="${esc(s.apk_md5)}" style="width:300px"></div>
      <div>Crash ALL users <select name="crash_all"><option value="0"${s.crash_all === '0' ? ' selected' : ''}>Off</option><option value="1"${s.crash_all === '1' ? ' selected' : ''}>On</option></select>
      message <input name="crash_message" value="${esc(s.crash_message)}"></div>
      <button>Save settings</button>
    </form>
    <p class="small">APK endpoints: POST /connect &nbsp; GET /update.php &nbsp; GET /apkhash.php &nbsp; Storage: ${dbKind}</p></div>
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
    if (p === '/connect' && req.method === 'GET') return await handleConnectGet(res);
    if (p === '/connect' && req.method === 'POST') return await handleConnectPost(req, res);
    if (p === '/update.php' || p === '/update') return await handleUpdate(res, url);
    if (p === '/apkhash.php' || p === '/apkhash') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
      return res.end(await getSetting('apk_md5'));
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
      return sendHtml(res, 200, await dashboardPage());
    }
    if (p === '/api/keys' && req.method === 'POST') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: 'login required' });
      const f = parseFields(req, await readBody(req));
      const key = String(f.user_key || '').trim() || genKey();
      const days = Math.max(1, parseInt(f.days, 10) || 30);
      const mdParsed = parseInt(f.max_devices, 10);
      const maxDevices = Number.isNaN(mdParsed) ? 1 : Math.max(0, mdParsed);
      const exp = new Date(Date.now() + days * 864e5).toISOString().slice(0, 19).replace('T', ' ');
      try {
        await dbRun('INSERT INTO keys(user_key,label,seller_name,registrator,expired_date,max_devices,created_at) VALUES(?,?,?,?,?,?,?)',
          key, f.label || '', f.seller_name || 'ANGRY MOD', f.registrator || 'Admin', exp, maxDevices, nowSql());
      } catch (e) { return sendHtml(res, 400, page('Error', '<p class="bad">Key already exists</p><p><a href="/dashboard">Back</a></p>')); }
      res.writeHead(302, { Location: '/dashboard' }); return res.end();
    }
    const m = p.match(/^\/api\/keys\/(\d+)\/action$/);
    if (m && req.method === 'POST') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: 'login required' });
      const f = parseFields(req, await readBody(req));
      const id = parseInt(m[1], 10);
      if (f.act === 'unbind') { await dbRun('DELETE FROM key_devices WHERE key_id=?', id); await dbRun('UPDATE keys SET serial=NULL WHERE id=?', id); }
      else if (f.act === 'ban') await dbRun("UPDATE keys SET status='banned' WHERE id=?", id);
      else if (f.act === 'unban') await dbRun("UPDATE keys SET status='active' WHERE id=?", id);
      else if (f.act === 'crash') await dbRun("UPDATE keys SET status='crash' WHERE id=?", id);
      else if (f.act === 'delete') { await dbRun('DELETE FROM key_devices WHERE key_id=?', id); await dbRun('DELETE FROM keys WHERE id=?', id); }
      res.writeHead(302, { Location: '/dashboard' }); return res.end();
    }
    if (p === '/api/settings' && req.method === 'POST') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: 'login required' });
      const f = parseFields(req, await readBody(req));
      for (const k of ['latest_version', 'latest_version_code', 'update_url', 'update_message', 'apk_md5', 'crash_all', 'crash_message', 'expired_link']) {
        if (f[k] !== undefined) await setSetting(k, f[k]);
      }
      res.writeHead(302, { Location: '/dashboard' }); return res.end();
    }
    if (p === '/healthz') return sendJson(res, 200, { name: 'angry-panel', version: '2.1.0', db: dbKind, ok: true });
    res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ status: false, reason: 'Not found' }));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { status: false, reason: 'Server error' });
  }
});

initDb()
  .then(() => server.listen(PORT, () => console.log('angry-panel v2 listening on port ' + PORT + ' (storage: ' + dbKind + ')')))
  .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
