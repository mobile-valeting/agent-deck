#!/usr/bin/env node
// Agent Deck backend — serves the dashboard + a small authenticated API that mirrors
// and controls the real Atom loop. Zero external deps (npm is gated on this box):
// Node built-ins only. Auth = Telegram Mini App initData (HMAC-SHA256 with the bot
// token), so only requests coming through the real bot are honoured. Bind to
// localhost and put a tunnel / reverse proxy in front for HTTPS (Telegram requires it).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT        = Number(process.env.PORT || 8787);
const HOST        = process.env.HOST || '127.0.0.1';
const ATOM        = process.env.ATOM_DIR || '/opt/empire/automation-lab/automations/atom';
const STATIC_DIR  = __dirname;
const ENV_FILE    = process.env.TELEGRAM_ENV || '/home/tris/n8n-client/telegram.env';
const ALLOWED_USER= process.env.ALLOWED_TG_USER || '';          // optional: lock to your TG user id
const AUTH_MAX_AGE= Number(process.env.AUTH_MAX_AGE_SEC || 86400);
const DEV_NO_AUTH = process.env.DEV_NO_AUTH === '1';            // localhost testing ONLY

function botToken() {
  try { const m = fs.readFileSync(ENV_FILE, 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.*)$/m); return m ? m[1].trim() : ''; }
  catch { return ''; }
}

// ---- Telegram initData verification (docs: core.telegram.org/bots/webapps#validating) ----
function verifyInitData(initData) {
  if (!initData) return { ok: false, reason: 'no initData' };
  const token = botToken(); if (!token) return { ok: false, reason: 'server missing bot token' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash'); if (!hash) return { ok: false, reason: 'no hash' };
  params.delete('hash');
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'))) return { ok: false, reason: 'bad signature' };
  const authDate = Number(params.get('auth_date') || 0);
  if (AUTH_MAX_AGE && authDate && (Date.now() / 1000 - authDate) > AUTH_MAX_AGE) return { ok: false, reason: 'stale auth' };
  let user = null; try { user = JSON.parse(params.get('user') || 'null'); } catch {}
  if (ALLOWED_USER && String(user && user.id) !== String(ALLOWED_USER)) return { ok: false, reason: 'user not allowed' };
  return { ok: true, user };
}
function auth(req) {
  if (DEV_NO_AUTH) return { ok: true, user: { id: 'dev' } };
  return verifyInitData(String(req.headers['x-telegram-init-data'] || ''));
}

const sendJSON = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => resolve(d)); });
const CT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (p === '/health') return sendJSON(res, 200, { ok: true });

  if (p === '/data.json') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    try { const d = fs.readFileSync(path.join(ATOM, 'state', 'dashboard.json'), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(d); }
    catch { return sendJSON(res, 404, { error: 'no dashboard.json yet — waiting for first tick' }); }
  }

  if (p === '/api/command' && req.method === 'POST') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    let j = {}; try { j = JSON.parse(await readBody(req) || '{}'); } catch {}
    const text = String(j.text || '').slice(0, 2000);
    const cmd = { comment: 'Set by Agent Deck prompt line.', text, status: 'pending', source: 'dashboard', setAt: new Date().toISOString(), pickedUpAt: null };
    try { fs.writeFileSync(path.join(ATOM, 'state', 'command.json'), JSON.stringify(cmd, null, 2) + '\n'); }
    catch { return sendJSON(res, 500, { error: 'write failed' }); }
    return sendJSON(res, 200, { ok: true, queued: text || '(blank → audit → optimise → expand)' });
  }

  if (p === '/api/control' && req.method === 'POST') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    let j = {}; try { j = JSON.parse(await readBody(req) || '{}'); } catch {}
    const action = j.action === 'resume' ? 'resume' : j.action === 'pause' ? 'pause' : null;
    if (!action) return sendJSON(res, 400, { error: 'action must be pause|resume' });
    return execFile('bash', [path.join(ATOM, 'loop', 'control.sh'), action, 'via Agent Deck'], (err, so, se) => {
      if (err) return sendJSON(res, 500, { error: 'control failed', detail: String(se || err) });
      return sendJSON(res, 200, { ok: true, action, out: String(so).trim() });
    });
  }

  // static files (dashboard)
  let file = p === '/' ? '/index.html' : p;
  const full = path.join(STATIC_DIR, path.normalize(file));
  if (!full.startsWith(STATIC_DIR)) return sendJSON(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': CT[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});
server.listen(PORT, HOST, () => console.log(`agent-deck server on http://${HOST}:${PORT}  (atom=${ATOM}, auth=${DEV_NO_AUTH ? 'DEV-OFF' : 'telegram'})`));
