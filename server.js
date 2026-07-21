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
const WPOOL       = process.env.WORKER_POOL_DIR || '/opt/empire/automation-lab/scripts/worker-pool';
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
let lastLoggedUser = null;
function auth(req) {
  if (DEV_NO_AUTH) return { ok: true, user: { id: 'dev' } };
  const r = verifyInitData(String(req.headers['x-telegram-init-data'] || ''));
  if (r.ok && r.user && r.user.id && r.user.id !== lastLoggedUser) {
    lastLoggedUser = r.user.id;
    console.log('authenticated Telegram user id:', r.user.id, r.user.username || r.user.first_name || '');
  }
  return r;
}

// fire a worker tick right now (detached) so a command runs within seconds, not on
// the next 15-min cron. run-worker.sh self-gates on control status + the flock lock.
function kickWorker() {
  try { const cp = require('child_process').spawn('bash', [path.join(ATOM, 'loop', 'run-worker.sh')], { detached: true, stdio: 'ignore' }); cp.unref(); }
  catch (e) {}
}

const sendJSON = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => resolve(d)); });
const CT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---- Outsourced (worker-pool free-tier LLM router) telemetry -----------------
// Mirrors pool.py's provider catalogue + FREE_TIER_HINT so the deck shows the same
// picture as `pool.py --status`, plus an hourly series for the live graph.
const WP_PROVIDERS = [
  { name: 'nvidia',     key: 'NVIDIA_API_KEY',     modelEnv: 'NVIDIA_MODEL',     dflt: 'meta/llama-3.3-70b-instruct',          hint: 'free credits, then rate-limited' },
  { name: 'groq',       key: 'GROQ_API_KEY',       modelEnv: 'GROQ_MODEL',       dflt: 'llama-3.3-70b-versatile',              hint: '~14.4k req/day · ~500k tok/day' },
  { name: 'gemini',     key: 'GEMINI_API_KEY',     modelEnv: 'GEMINI_MODEL',     dflt: 'gemini-flash-latest',                  hint: '~200 req/day · 15 req/min' },
  { name: 'openrouter', key: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', dflt: 'meta-llama/llama-3.3-70b-instruct:free', hint: '~50 req/day on :free models' },
  { name: 'cerebras',   key: 'CEREBRAS_API_KEY',   modelEnv: 'CEREBRAS_MODEL',   dflt: 'llama-3.3-70b',                        hint: '~14.4k req/day (free tier)' },
  { name: 'mistral',    key: 'MISTRAL_API_KEY',    modelEnv: 'MISTRAL_MODEL',    dflt: 'mistral-small-latest',                 hint: 'free tier · ~1 req/sec' },
  { name: 'sambanova',  key: 'SAMBANOVA_API_KEY',  modelEnv: 'SAMBANOVA_MODEL',  dflt: 'Meta-Llama-3.3-70B-Instruct',          hint: 'free tier · fast inference' },
  { name: 'cloudflare', key: 'CLOUDFLARE_API_TOKEN', modelEnv: 'CLOUDFLARE_MODEL', dflt: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', hint: '~10k neurons/day (Workers AI)' },
];

function parseEnvFile(file) {
  const out = {};
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

// quick, timeboxed liveness check of the python proxy
function proxyHealth() {
  return new Promise((resolve) => {
    const done = (v) => { try { r.destroy(); } catch {} resolve(v); };
    const r = http.get({ host: '127.0.0.1', port: 8899, path: '/health', timeout: 500 }, (resp) => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { try { resolve(!!JSON.parse(d).ok); } catch { resolve(false); } });
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => done(false));
  });
}

function buildOutsourced() {
  const env = parseEnvFile(path.join(WPOOL, '.env'));
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const perProvider = {};
  const hours = [];                       // last 24 hourly buckets (oldest → newest)
  for (let h = 23; h >= 0; h--) {
    const d = new Date(now.getTime() - h * 3600e3);
    hours.push({ label: String(d.getHours()).padStart(2, '0') + ':00', tokens: 0, calls: 0 });
  }
  const recent = [];
  let totOk = 0, totFail = 0, totTok = 0;

  try {
    const lines = fs.readFileSync(path.join(WPOOL, 'usage.jsonl'), 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      // per-provider tally is "today" only, to match pool.py --status
      if (r.day === today) {
        const s = perProvider[r.provider] || (perProvider[r.provider] = { ok: 0, fail: 0, tokens: 0, lastError: null });
        if (r.ok) { s.ok++; s.tokens += r.total_tokens || 0; totOk++; totTok += r.total_tokens || 0; }
        else { s.fail++; s.lastError = r.error || null; totFail++; }
      }
      // hourly series spans the rolling last 24h (across the midnight boundary)
      const t = new Date((r.ts || '').replace(' ', 'T'));
      if (!isNaN(t)) {
        const hoursAgo = Math.floor((now - t) / 3600e3);
        if (hoursAgo >= 0 && hoursAgo <= 23) {
          const b = hours[23 - hoursAgo];
          b.calls++; if (r.ok) b.tokens += r.total_tokens || 0;
        }
        recent.push(r);
      }
    }
  } catch {}

  const providers = WP_PROVIDERS.map((p) => {
    const s = perProvider[p.name] || { ok: 0, fail: 0, tokens: 0, lastError: null };
    const hasKey = !!(env[p.key] && env[p.key].length);
    let status = 'nokey';
    if (hasKey) status = s.fail > 0 && s.ok === 0 ? 'error' : s.ok > 0 ? 'live' : 'ready';
    return {
      name: p.name, hasKey, status,
      model: env[p.modelEnv] || p.dflt, hint: p.hint,
      ok: s.ok, fail: s.fail, tokens: s.tokens, lastError: s.lastError,
    };
  });

  const online = providers.filter((p) => p.hasKey).length;
  const recentTail = recent.slice(-14).reverse().map((r) => ({
    ts: r.ts, provider: r.provider, ok: !!r.ok,
    tokens: r.total_tokens || 0, error: r.error || null,
  }));

  return {
    updatedAt: now.toISOString(),
    today: { calls: totOk + totFail, ok: totOk, fail: totFail, tokens: totTok },
    providersOnline: online, providersTotal: WP_PROVIDERS.length,
    providers, series: hours, recent: recentTail,
  };
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (p === '/health') return sendJSON(res, 200, { ok: true });

  if (p === '/whoami') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    return sendJSON(res, 200, { ok: true, user: a.user });
  }

  if (p === '/data.json') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    try { const d = fs.readFileSync(path.join(ATOM, 'state', 'dashboard.json'), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(d); }
    catch { return sendJSON(res, 404, { error: 'no dashboard.json yet — waiting for first tick' }); }
  }

  if (p === '/businesses.json') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    try { const d = fs.readFileSync(path.join(ATOM, 'state', 'businesses.json'), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(d); }
    catch { return sendJSON(res, 404, { error: 'no businesses.json' }); }
  }

  if (p === '/capabilities.json') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    try { const d = fs.readFileSync(path.join(ATOM, 'state', 'capabilities.json'), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(d); }
    catch { return sendJSON(res, 404, { error: 'no capabilities.json yet — waiting for first self-upgrade run' }); }
  }

  if (p === '/outsourced.json') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    try {
      const data = buildOutsourced();
      data.proxy = { up: await proxyHealth(), host: '127.0.0.1', port: 8899, url: 'http://127.0.0.1:8899/v1' };
      return sendJSON(res, 200, data);
    } catch (e) { return sendJSON(res, 500, { error: 'outsourced build failed', detail: String(e) }); }
  }

  if (p === '/api/command' && req.method === 'POST') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    let j = {}; try { j = JSON.parse(await readBody(req) || '{}'); } catch {}
    const text = String(j.text || '').slice(0, 2000);
    const cmd = { comment: 'Set by Agent Deck prompt line.', text, status: 'pending', source: 'dashboard', setAt: new Date().toISOString(), pickedUpAt: null };
    try { fs.writeFileSync(path.join(ATOM, 'state', 'command.json'), JSON.stringify(cmd, null, 2) + '\n'); }
    catch { return sendJSON(res, 500, { error: 'write failed' }); }
    kickWorker();
    return sendJSON(res, 200, { ok: true, queued: text || '(blank → audit → optimise → expand)' });
  }

  if (p === '/api/agent' && req.method === 'POST') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    let j = {}; try { j = JSON.parse(await readBody(req) || '{}'); } catch {}
    const file = path.join(ATOM, 'state', 'agents.json');
    let store; try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { store = { agents: [] }; }
    store.agents = store.agents || [];
    let changed = false, enabledNow = false;
    if (j.delete && j.id) { store.agents = store.agents.filter(x => x.id !== j.id); changed = true; }
    else if (j.id) {
      const ag = store.agents.find(x => x.id === j.id);
      if (ag) {
        if (typeof j.enabled === 'boolean') { ag.enabled = j.enabled; enabledNow = j.enabled; }
        if (typeof j.brief === 'string') ag.brief = j.brief.slice(0, 600);
        if (typeof j.name === 'string' && j.name.trim()) ag.name = j.name.slice(0, 40);
        changed = true;
      }
    } else if (j.name) {
      let model = 'opus';
      try { model = String(JSON.parse(fs.readFileSync(path.join(ATOM, 'config.json'), 'utf8')).workerModel || 'opus').replace(/^claude-/, ''); } catch {}
      store.agents.push({ id: 'a' + Date.now(), name: j.name.slice(0, 40), brief: String(j.brief || '').slice(0, 600), enabled: j.enabled !== false, model });
      changed = true; enabledNow = true;
    }
    if (!changed) return sendJSON(res, 400, { error: 'need id, name, or delete' });
    try { fs.writeFileSync(file, JSON.stringify(store, null, 2) + '\n'); } catch { return sendJSON(res, 500, { error: 'write failed' }); }
    if (enabledNow) kickWorker();
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/needed.json') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    try { const d = fs.readFileSync(path.join(ATOM, 'state', 'needed-from-tris.json'), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(d); }
    catch { return sendJSON(res, 404, { error: 'no needed-from-tris.json yet' }); }
  }

  if (p === '/api/needed-done' && req.method === 'POST') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    let j = {}; try { j = JSON.parse(await readBody(req) || '{}'); } catch {}
    const id = String(j.id || '').slice(0, 60);
    if (!id) return sendJSON(res, 400, { error: 'need id' });
    let action = '';
    try { const nf = JSON.parse(fs.readFileSync(path.join(ATOM, 'state', 'needed-from-tris.json'), 'utf8'));
      const it = (nf.items || []).find(x => x.id === id); if (it) action = String(it.action || '').slice(0, 120); } catch {}
    const text = `[Agent Deck] Needed-from-Tris item "${id}"${action ? ` (${action})` : ''}: Tris marks this DONE. Verify it for real (key present / account works / reply received), then set doneAt in state/needed-from-tris.json and refresh the vault mirror + JARVIS block. If it doesn't verify, reopen it and tell Tris exactly what's missing.`;
    // same block-reply path as approvals (worker Step 1 reads inbox.jsonl)
    const line = JSON.stringify({ update_id: 0, date: Math.floor(Date.now() / 1000), text, source: 'agent-deck' }) + '\n';
    try { fs.appendFileSync(path.join(ATOM, 'state', 'inbox.jsonl'), line); }
    catch { return sendJSON(res, 500, { error: 'write failed' }); }
    kickWorker();
    return sendJSON(res, 200, { ok: true, id });
  }

  if (p === '/api/approve' && req.method === 'POST') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    let j = {}; try { j = JSON.parse(await readBody(req) || '{}'); } catch {}
    const id = String(j.id || '').slice(0, 40);
    const decision = j.decision === 'approve' ? 'approve' : j.decision === 'reject' ? 'reject' : null;
    const note = String(j.note || '').slice(0, 500);
    if (!id || !decision) return sendJSON(res, 400, { error: 'need id + decision (approve|reject)' });
    let task = '';
    try { const bl = JSON.parse(fs.readFileSync(path.join(ATOM, 'state', 'blocked.json'), 'utf8'));
      const b = (bl.blocks || []).find(x => x.id === id); if (b) task = b.task; } catch {}
    const verb = decision === 'approve' ? 'APPROVED — go ahead' : 'REJECTED — do not proceed; drop or defer it';
    const text = `[Agent Deck] Block ${id}${task !== '' ? ` (task #${task})` : ''}: ${verb}.${note ? ' ' + note : ''}`;
    // feed Atom's existing block-reply path (worker Step 1 reads inbox.jsonl)
    const line = JSON.stringify({ update_id: 0, date: Math.floor(Date.now() / 1000), text, source: 'agent-deck' }) + '\n';
    try { fs.appendFileSync(path.join(ATOM, 'state', 'inbox.jsonl'), line); }
    catch { return sendJSON(res, 500, { error: 'write failed' }); }
    kickWorker();
    return sendJSON(res, 200, { ok: true, id, decision });
  }

  if (p === '/api/control' && req.method === 'POST') {
    const a = auth(req); if (!a.ok) return sendJSON(res, 401, { error: a.reason });
    let j = {}; try { j = JSON.parse(await readBody(req) || '{}'); } catch {}
    const action = j.action === 'resume' ? 'resume' : j.action === 'pause' ? 'pause' : null;
    if (!action) return sendJSON(res, 400, { error: 'action must be pause|resume' });
    return execFile('bash', [path.join(ATOM, 'loop', 'control.sh'), action, 'via Agent Deck'], (err, so, se) => {
      if (err) return sendJSON(res, 500, { error: 'control failed', detail: String(se || err) });
      if (action === 'resume') kickWorker();
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
