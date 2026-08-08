'use strict';
// Agent Deck — system control surface: cron jobs, long-running services, maintenance
// scripts, and token spend. Node built-ins only (npm is gated on this box).
//
// WHY: everything here was previously SSH-only. That is how a focus venture's cron sat
// commented out for three days without anyone noticing, and how the only way to see what
// was burning the credit window was to log in and read a log. If it can't be seen and
// changed from the phone, it doesn't get seen or changed.
//
// Destructive actions (stopping a service, disabling a job) are marked `destructive` so
// the UI can confirm before firing. Nothing here can spend money — that hard stop lives
// in the CHARTER and is deliberately not reachable from this surface.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const LAB = process.env.LAB_DIR || '/opt/empire/automation-lab';
const ATOM = process.env.ATOM_DIR || path.join(LAB, 'automations', 'atom');
const NODE = process.env.NODE_BIN || '/home/tris/.nvm/versions/node/v20.20.2/bin/node';
const USERCTL_ENV = { ...process.env, XDG_RUNTIME_DIR: '/run/user/1000' };

const sh = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: opts.timeout || 20000, maxBuffer: 4e6, env: opts.env || process.env },
    (err, so, se) => resolve({ ok: !err, out: String(so || '').trim(), err: String(se || err || '').trim() }));
});

// A cron's identity must survive being commented out, so it is derived from the command
// only — never from the line, which changes the moment you disable it.
const cronId = (cmd) => crypto.createHash('sha1').update(cmd.trim()).digest('hex').slice(0, 10);

// Jobs whose failure is invisible without this panel. `log` lets the UI show staleness
// next to the toggle, which is the signal that would have caught the betting-arb cron.
const CRON_LOGS = [
  [/betting-arb/, `${ATOM}/ventures/betting-arb/test-data/cron.log`],
  [/iphone-flipping\/run-recurring/, `${LAB}/data/iphone-flipping/run.log`],
  [/growth-intel/, `${LAB}/automations/growth-intel/state/run.log`],
  [/accountability/, `${LAB}/automations/accountability/state-run.log`],
  [/vault-health/, `${LAB}/automations/vault-health/health.log`],
  [/system-health/, `${LAB}/data/system-health/run.log`],
  [/needed-rank/, `${LAB}/data/needed-rank/run.log`],
  [/clip-farming/, `${LAB}/data/clip-farming/run.log`],
  [/run-worker/, `${ATOM}/loop/worker.log`],
  [/run-subworker/, `${ATOM}/loop/subworker.log`],
  [/self-upgrade/, `${ATOM}/loop/self-upgrade.log`],
  [/security-audit/, `${LAB}/data/security-audit/run.log`],
  [/valeting|mobile-valeting-leadgen/, `${LAB}/data/valeting-leadgen/run.log`],
];

const ageHours = (f) => {
  try { return (Date.now() - fs.statSync(f).mtimeMs) / 3600000; } catch { return null; }
};

// A cron schedule is five fields of digits/*/,//- , or an @keyword. This must be STRICT:
// a loose "five whitespace-separated tokens" test reads the prose comment
//   #FROZEN 2026-08-05 (25 Plan kill list — zero arbs measured...)
// as a disabled job, and then "enabling" it writes that sentence into the crontab as a
// command. Anything looser corrupts the file it is meant to manage.
const CRON_SCHEDULE = String.raw`(?:@(?:reboot|yearly|annually|monthly|weekly|daily|hourly)|(?:[\d*,/-]+\s+){4}[\d*,/-]+)`;
const DISABLED_RE = new RegExp(`^#\\s*${CRON_SCHEDULE}\\s+\\S`);
const JOB_RE = new RegExp(`^(${CRON_SCHEDULE})\\s+(.+)$`);

// Best human-readable name for a job with no `# comment` tag: the script it runs.
function scriptName(cmd) {
  const m = [...cmd.matchAll(/([\w.-]+\.(?:sh|js|py))\b/g)].pop();
  return m ? m[1] : cmd.split(/\s+/).find((t) => t.startsWith('/')) || cmd.slice(0, 40);
}

// Splits a crontab line into {schedule, cmd, label, enabled}, or null if it isn't a job.
function parseLine(raw) {
  const line = raw.trim();
  if (!line) return null;
  const off = DISABLED_RE.test(line);
  if (line.startsWith('#') && !off) return null;
  const body = off ? line.replace(/^#\s*/, '') : line;
  const m = body.match(JOB_RE);
  if (!m) return null;
  const rest = m[2];
  const hashIdx = rest.lastIndexOf(' #');
  return {
    schedule: m[1],
    cmd: (hashIdx > -1 ? rest.slice(0, hashIdx) : rest).trim(),
    label: (hashIdx > -1 ? rest.slice(hashIdx + 2) : '').trim(),
    enabled: !off,
    body,
  };
}

function parseCrontab(text) {
  const jobs = [];
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    const j = parseLine(raw);
    if (!j) return;
    const logEntry = CRON_LOGS.find(([re]) => re.test(j.cmd));
    // A disabled job usually has a human note directly above saying WHY. Surfacing it
    // stops the deck from presenting a deliberate freeze as a broken job to switch on.
    let note = '';
    if (!j.enabled) {
      const prev = (lines[i - 1] || '').trim();
      if (prev.startsWith('#') && !DISABLED_RE.test(prev)) note = prev.replace(/^#\s*/, '');
    }
    jobs.push({
      id: cronId(j.cmd), schedule: j.schedule, cmd: j.cmd, enabled: j.enabled,
      // Falling back to the last token yields "2>&1" for any job without a `# comment`
      // tag. The script being run is what identifies it to a human.
      label: j.label || scriptName(j.cmd),
      disabledNote: note,
      lastRunHoursAgo: logEntry ? ageHours(logEntry[1]) : null,
      destructive: true, // toggling any scheduled job is worth a confirm
    });
  });
  return jobs;
}

async function listCrons() {
  const r = await sh('crontab', ['-l']);
  if (!r.ok) return [];
  return parseCrontab(r.out);
}

// Rewrites the crontab by toggling the '#' on exactly the line whose COMMAND matches.
// Never rewrites anything else: the file is read, one line changed, and written back.
async function toggleCron(id, enable) {
  const cur = await sh('crontab', ['-l']);
  if (!cur.ok) return { ok: false, error: 'could not read crontab' };
  let found = null;
  const out = cur.out.split('\n').map((raw) => {
    const j = parseLine(raw);
    if (!j || cronId(j.cmd) !== id) return raw;
    found = j.cmd;
    return enable ? j.body : `#${j.body}`;
  }).join('\n');
  if (!found) return { ok: false, error: 'no cron job with that id' };

  const tmp = `/tmp/agentdeck-crontab-${Date.now()}`;
  fs.writeFileSync(tmp, out.replace(/\s*$/, '') + '\n');
  const w = await sh('crontab', [tmp]);
  try { fs.unlinkSync(tmp); } catch {}
  if (!w.ok) return { ok: false, error: `crontab write failed: ${w.err}` };
  return { ok: true, id, enabled: enable, cmd: found };
}

// ------------------------------------------------------------------ services
const SERVICES = [
  { id: 'telegram-bridge', label: 'Telegram bridge', unit: 'telegram-bridge.service' },
  { id: 'llm-proxy', label: 'Free-tier LLM proxy (:8899)', url: 'http://127.0.0.1:8899/v1/models', start: `${LAB}/scripts/worker-pool/run-proxy.sh` },
  { id: 'ollama', label: 'Local Qwen / Ollama (:11434)', url: 'http://127.0.0.1:11434/api/tags', start: `${LAB}/scripts/local-llm/run-ollama.sh` },
  { id: 'agent-deck', label: 'Agent Deck (this server)', url: 'http://127.0.0.1:8787/health', start: '/home/tris/agent-deck/run.sh', protected: true },
];

async function probe(s) {
  if (s.unit) return (await sh('systemctl', ['--user', 'is-active', s.unit], { env: USERCTL_ENV })).out === 'active';
  const r = await sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', s.url], { timeout: 9000 });
  return r.ok && /^[23]/.test(r.out);
}

async function listServices() {
  return Promise.all(SERVICES.map(async (s) => ({
    id: s.id, label: s.label, up: await probe(s),
    // Restarting the deck kills the request that asked for it, so the UI hides that one.
    canRestart: !s.protected, canStop: !!s.unit && !s.protected, destructive: true,
  })));
}

async function serviceAction(id, action) {
  const s = SERVICES.find((x) => x.id === id);
  if (!s) return { ok: false, error: 'unknown service' };
  if (s.protected) return { ok: false, error: 'this service cannot be controlled from its own dashboard' };
  if (action === 'stop') {
    if (!s.unit) return { ok: false, error: 'no stop for this service' };
    const r = await sh('systemctl', ['--user', 'stop', s.unit], { env: USERCTL_ENV });
    return { ok: r.ok, error: r.ok ? undefined : r.err };
  }
  if (action !== 'restart') return { ok: false, error: 'action must be restart|stop' };
  const r = s.unit
    ? await sh('systemctl', ['--user', 'restart', s.unit], { env: USERCTL_ENV })
    : await sh('bash', [s.start], { timeout: 60000 });
  if (!r.ok) return { ok: false, error: r.err };
  return { ok: true, up: await probe(s) };
}

// -------------------------------------------------------------- maintenance
// Everything here is deterministic and costs ZERO Claude tokens, so running one on a
// whim is always safe. That is the point: they were cron-only, so a stale list or an
// unrepaired vault had to wait for its schedule.
const MAINTENANCE = [
  { id: 'credit-minimiser', label: 'Find + fix credit waste', cmd: [NODE, [`${LAB}/automations/system-health/credit-minimiser.js`]] },
  { id: 'health-check', label: 'Run full system health check', cmd: [NODE, [`${LAB}/automations/system-health/check.js`, '--report']] },
  { id: 'needed-rank', label: 'Re-rank the to-do list', cmd: [NODE, [`${LAB}/automations/atom/loop/needed-rank.js`]] },
  { id: 'vault-repair', label: 'Repair the Obsidian vault', cmd: [NODE, [`${LAB}/automations/vault-health/scan.js`]] },
  { id: 'token-report', label: 'Refresh token usage figures', cmd: [NODE, [`${ATOM}/loop/token-report.js`]] },
  { id: 'dashboard-report', label: 'Refresh this dashboard\'s data', cmd: [NODE, [`${ATOM}/loop/dashboard-report.js`]] },
];

const listMaintenance = () => MAINTENANCE.map((m) => ({ id: m.id, label: m.label, destructive: false }));

async function runMaintenance(id) {
  const m = MAINTENANCE.find((x) => x.id === id);
  if (!m) return { ok: false, error: 'unknown job' };
  const r = await sh(m.cmd[0], m.cmd[1], { timeout: 180000, env: { ...process.env, VAULT_DIR: '/home/tris/obsidian-vault' } });
  return { ok: r.ok, output: (r.out || r.err || '(no output)').slice(-4000) };
}

// -------------------------------------------------------------------- spend
// Parsed from the report token-report.js writes. Regenerated on demand when stale, so
// the panel is never showing figures from days ago without saying so.
const COSTS_MD = path.join(ATOM, 'state', 'token-costs.md');

async function spend({ maxAgeMin = 30 } = {}) {
  const age = ageHours(COSTS_MD);
  if (age === null || age * 60 > maxAgeMin) {
    await sh(NODE, [path.join(ATOM, 'loop', 'token-report.js')], { timeout: 120000 });
  }
  let rows = [];
  try {
    for (const line of fs.readFileSync(COSTS_MD, 'utf8').split('\n')) {
      const c = line.split('|').map((x) => x.trim()).filter(Boolean);
      if (c.length < 7 || !/^\d{4}-\d{2}-\d{2}$/.test(c[0])) continue;
      rows.push({ day: c[0], model: c[1], calls: Number(c[2]) || 0, in: c[3], cacheWrite: c[4], cacheRead: c[5], out: c[6] });
    }
  } catch { /* no report yet */ }

  const byDay = new Map();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) || 0) + r.calls);
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  let workerModel = null;
  try { workerModel = JSON.parse(fs.readFileSync(path.join(ATOM, 'config.json'), 'utf8')).workerModel; } catch {}

  return {
    generatedHoursAgo: ageHours(COSTS_MD),
    today: days[0] ? { day: days[0][0], calls: days[0][1] } : null,
    days: days.slice(0, 10).map(([day, calls]) => ({ day, calls })),
    rows: rows.slice(0, 24),
    workerModel,
    // Offered rather than free-typed: a typo here silently multiplies every tick's cost.
    workerModelOptions: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'],
  };
}

function setWorkerModel(model) {
  const allowed = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'];
  if (!allowed.includes(model)) return { ok: false, error: 'model not in the allowed list' };
  const p = path.join(ATOM, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { ok: false, error: 'config.json unreadable' }; }
  cfg.workerModel = model;
  const tmp = `${p}.deck.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(tmp, p);
  return { ok: true, workerModel: model };
}

// ------------------------------------------------------------------ backlog
const BACKLOG = path.join(ATOM, 'state', 'backlog.json');
const readBacklog = () => { try { return JSON.parse(fs.readFileSync(BACKLOG, 'utf8')); } catch { return { tasks: [] }; } };

function listBacklog() {
  return (readBacklog().tasks || []).map((t) => ({
    id: t.id, title: t.title, status: t.status, type: t.type,
    venture: t.venture, priority: t.priority, notBefore: t.notBefore || null,
    assignee: t.assignee || null,
  }));
}

// Status/priority only. Editing free text from a phone invites the shell-quoting and
// JSON-corruption failures this repo has already been bitten by twice.
function updateBacklog({ id, status, priority }) {
  const doc = readBacklog();
  const t = (doc.tasks || []).find((x) => String(x.id) === String(id));
  if (!t) return { ok: false, error: 'no task with that id' };
  const STATUSES = ['todo', 'doing', 'blocked', 'parked', 'done'];
  const PRIORITIES = ['high', 'med', 'low'];
  if (status) {
    if (!STATUSES.includes(status)) return { ok: false, error: `status must be one of ${STATUSES.join('|')}` };
    t.status = status;
  }
  if (priority) {
    if (!PRIORITIES.includes(priority)) return { ok: false, error: `priority must be one of ${PRIORITIES.join('|')}` };
    t.priority = priority;
  }
  t.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  t.updatedVia = 'agent-deck';
  const tmp = `${BACKLOG}.deck.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, BACKLOG);
  return { ok: true, id: t.id, status: t.status, priority: t.priority };
}

module.exports = {
  listCrons, toggleCron, listServices, serviceAction,
  listMaintenance, runMaintenance, spend, setWorkerModel,
  listBacklog, updateBacklog, parseCrontab,
};
