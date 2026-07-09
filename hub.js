import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createAuth, attachOAuth2, oauth2ConfigFromEnv } from './auth.js';
import { encodeData, decodeData } from './wire.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 7654;
const HOST = process.env.HOST || '0.0.0.0';
const SCROLLBACK = Number(process.env.SCROLLBACK) || 200_000; // replay bytes cached per session
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MACHINES_FILE = path.join(DATA_DIR, 'machines.json');
const ALIASES_FILE = path.join(DATA_DIR, 'aliases.json');
const PAIR_TTL_MS = Number(process.env.PAIR_TTL_MS) || 5 * 60 * 1000;

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* best-effort */ }

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rndHex = (n) => crypto.randomBytes(n).toString('hex');

// --- machine registry (persisted to a mounted volume) ----------------------
// machines.json: [{ id, name, tokenHash, addedAt }]
function loadMachines() {
  try { return JSON.parse(fs.readFileSync(MACHINES_FILE, 'utf8')); } catch { return []; }
}
function saveMachines() {
  const tmp = `${MACHINES_FILE}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(machines, null, 2)); fs.renameSync(tmp, MACHINES_FILE); } catch { /* best-effort */ }
}
const machines = loadMachines();

// --- session aliases (display-only rename, persisted on the hub) -------------
// The real session name lives on the agent; here we just overlay a per-machine
// alias keyed by session id, so a browser can rename a window without touching
// the agent. Shape: { [machineId]: { [sid]: alias } }.
function loadAliases() {
  try { return JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8')); } catch { return {}; }
}
function saveAliases() {
  const tmp = `${ALIASES_FILE}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(aliases, null, 2)); fs.renameSync(tmp, ALIASES_FILE); } catch { /* best-effort */ }
}
const aliases = loadAliases();
function setAlias(mid, sid, name) {
  const v = String(name || '').trim();
  if (!v) { if (aliases[mid]) { delete aliases[mid][sid]; if (!Object.keys(aliases[mid]).length) delete aliases[mid]; } }
  else { (aliases[mid] || (aliases[mid] = {}))[sid] = v; }
  saveAliases();
}
// Drop aliases for sessions that no longer exist (called when an agent reports
// its live session list), so the file doesn't grow unbounded.
function pruneAliases(mid, liveSids) {
  const map = aliases[mid];
  if (!map) return;
  let changed = false;
  for (const sid of Object.keys(map)) if (!liveSids.has(sid)) { delete map[sid]; changed = true; }
  if (!Object.keys(map).length) delete aliases[mid];
  if (changed) saveAliases();
}

// --- live agent connections + relay state ----------------------------------
// machineId -> { ws|null, online, sessions:[info], replay:Map<sid,Buffer>, pending:Map<reqId,{resolve,timer}> }
const agents = new Map();
function agentState(id) {
  let a = agents.get(id);
  if (!a) { a = { ws: null, online: false, sessions: [], replay: new Map(), pending: new Map() }; agents.set(id, a); }
  return a;
}

// Sanitize a replayed scrollback before sending it to a newly-attaching browser
// (never touches the live stream). Two classes of junk, both from replaying state
// whose original context is gone:
//   1. Query sequences — DA (`ESC[c`/`ESC[?...c`), DSR (`ESC[5n`/`ESC[6n`). The
//      client answers them, and the answer lands on a bare prompt → "1;2c".
//   2. Mouse-tracking ENABLES (`ESC[?1000h`..`1006h`/`1015h`/`1016h`) left on by
//      a program that exited without disabling them. Replaying re-arms xterm, so
//      every pointer move gets echoed as text → "35;57;44M…" flooding the screen.
// We also collapse any already-accumulated runs of those echoed mouse reports.
const STRIP_QUERY = /\x1b\[[0-9;>?]*[cn]|\x1b\[\?(?:100[0-6]|101[56])h/g;
const STRIP_MOUSE_ECHO = /(?:\d{1,4};\d{1,4};\d{1,4}[Mm]){2,}/g;
function stripReplayQueries(buf) {
  return Buffer.from(
    buf.toString('latin1').replace(STRIP_QUERY, '').replace(STRIP_MOUSE_ECHO, ''),
    'latin1',
  );
}

// (machineId:sid) -> Set<browser ws>
const browsers = new Map();
const bkey = (mid, sid) => `${mid}:${sid}`;
function addBrowser(mid, sid, ws) {
  const k = bkey(mid, sid);
  if (!browsers.has(k)) browsers.set(k, new Set());
  browsers.get(k).add(ws);
}
function removeBrowser(mid, sid, ws) {
  const set = browsers.get(bkey(mid, sid));
  if (set) { set.delete(ws); if (!set.size) browsers.delete(bkey(mid, sid)); }
}
function browsersFor(mid, sid) { return browsers.get(bkey(mid, sid)) || new Set(); }

// --- pairing codes (in-memory, one-time, short-lived) ----------------------
const pairCodes = new Map(); // code -> expiresAt
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
function newPairCode() {
  let c = '';
  const b = crypto.randomBytes(7);
  for (let i = 0; i < 7; i++) c += PAIR_ALPHABET[b[i] % PAIR_ALPHABET.length];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

const oauthCfg = oauth2ConfigFromEnv();
const auth = createAuth({ extraEnabled: oauthCfg.enabled });

const app = express();
app.use(express.json());

// --- browser auth (unchanged from the single-host server) ------------------
function isLocalRequest(req) {
  const ra = req.socket.remoteAddress || '';
  const loopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  const proxied = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-host'];
  return loopback && !proxied;
}
app.post('/api/login', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'token login is local-only; use OAuth2' });
  const user = auth.tokenLogin(req.body && req.body.token);
  if (!user) return res.status(401).json({ error: 'invalid token' });
  const token = auth.issueSession(res, user);
  res.json({ ok: true, token, user });
});
// Native-client login: a native app (iOS) can't ride the browser OAuth2 cookie
// redirect, so it authenticates with the shared AUTH_TOKEN (the same secret the
// local web login uses) and gets back a session token. Unlike /api/login this is
// NOT local-only — the token itself is the credential — but it only works when
// AUTH_TOKEN is configured. The returned token is used as `Authorization: Bearer`
// for REST and `?access_token=` for the terminal WebSocket.
app.post('/api/app/login', (req, res) => {
  const user = auth.tokenLogin(req.body && req.body.token);
  if (!user) return res.status(401).json({ error: 'invalid token' });
  const token = auth.issueSession(res, user);
  res.json({ ok: true, token, user });
});
app.post('/api/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });
app.get('/api/me', auth.requireAuth, (req, res) => {
  res.json({ user: req.user, authEnabled: auth.enabled, oauth2: oauthCfg.enabled });
});
attachOAuth2(app, auth, oauthCfg);

// --- pairing ---------------------------------------------------------------
// A logged-in user mints a one-time code in the web UI...
app.post('/api/pair/new', auth.requireAuth, (_req, res) => {
  const code = newPairCode();
  pairCodes.set(code, Date.now() + PAIR_TTL_MS);
  res.json({ code, expiresInSec: Math.round(PAIR_TTL_MS / 1000) });
});
// ...and a new agent redeems it for a per-machine token (no browser auth here).
app.post('/agent/pair', (req, res) => {
  const { code, name } = req.body || {};
  const exp = pairCodes.get(code);
  if (!exp) return res.status(401).json({ error: 'invalid pairing code' });
  pairCodes.delete(code); // one-time
  if (Date.now() > exp) return res.status(401).json({ error: 'pairing code expired' });
  const id = rndHex(4);
  const token = rndHex(24);
  machines.push({ id, name: name || id, tokenHash: sha256(token), addedAt: Date.now() });
  saveMachines();
  console.log(`paired new machine: ${name} (${id})`);
  res.json({ machineId: id, name: name || id, token });
});

// --- machine registry API (browser auth) -----------------------------------
app.get('/api/agents', auth.requireAuth, (_req, res) => {
  res.json({
    agents: machines.map((m) => {
      const a = agents.get(m.id);
      return { id: m.id, name: m.name, online: !!(a && a.online), sessions: a ? a.sessions.length : 0, addedAt: m.addedAt };
    }),
  });
});
app.delete('/api/agents/:id', auth.requireAuth, (req, res) => {
  const idx = machines.findIndex((m) => m.id === req.params.id);
  if (idx < 0) return res.status(404).json({ ok: false });
  machines.splice(idx, 1);
  saveMachines();
  const a = agents.get(req.params.id);
  if (a && a.ws) try { a.ws.close(4003, 'revoked'); } catch { /* ignore */ }
  agents.delete(req.params.id);
  res.json({ ok: true });
});

// --- session API on a given machine (browser auth) -------------------------
app.get('/api/agents/:id/sessions', auth.requireAuth, (req, res) => {
  const a = agents.get(req.params.id);
  if (!a || !a.online) return res.status(503).json({ error: 'machine offline', sessions: [] });
  const map = aliases[req.params.id] || {};
  // Overlay the hub-side alias onto the display name; keep the original too.
  res.json({ sessions: a.sessions.map((s) => map[s.id] ? { ...s, name: map[s.id], origName: s.name } : s) });
});
// Rename a session (display-only alias). Empty name clears it back to the original.
app.patch('/api/agents/:id/sessions/:sid', auth.requireAuth, (req, res) => {
  setAlias(req.params.id, req.params.sid, req.body && req.body.name);
  res.json({ ok: true });
});
app.post('/api/agents/:id/sessions', auth.requireAuth, (req, res) => {
  const a = agents.get(req.params.id);
  if (!a || !a.online || !a.ws) return res.status(503).json({ error: 'machine offline' });
  const reqId = rndHex(6);
  const timer = setTimeout(() => { a.pending.delete(reqId); res.status(504).json({ error: 'agent timeout' }); }, 10000);
  a.pending.set(reqId, { resolve: (session) => res.status(201).json({ session }), timer });
  a.ws.send(JSON.stringify({ t: 'create', reqId, name: req.body && req.body.name }));
});
app.delete('/api/agents/:id/sessions/:sid', auth.requireAuth, (req, res) => {
  const a = agents.get(req.params.id);
  if (!a || !a.ws) return res.status(503).json({ ok: false });
  a.ws.send(JSON.stringify({ t: 'kill', sid: req.params.sid }));
  setAlias(req.params.id, req.params.sid, ''); // drop the alias along with the session
  res.json({ ok: true });
});

// --- Claude usage (forwarded to the standalone usage service) --------------
const USAGE_API_URL = (process.env.USAGE_API_URL || 'http://127.0.0.1:7655').replace(/\/$/, '');
app.use('/api/usage', auth.requireAuth, async (req, res) => {
  const suffix = req.path === '/' ? '' : req.path;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  try {
    const r = await fetch(`${USAGE_API_URL}/api/usage${suffix}`, {
      method: req.method,
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(req.body || {}) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    res.status(r.status).type('application/json').send(await r.text());
  } catch (e) {
    res.status(502).json({ error: `usage service unreachable: ${String(e.message || e)}` });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wssBrowser = new WebSocketServer({ noServer: true });
const wssAgent = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws') wssBrowser.handleUpgrade(req, socket, head, (ws) => wssBrowser.emit('connection', ws, req));
  else if (pathname === '/agent') wssAgent.handleUpgrade(req, socket, head, (ws) => wssAgent.emit('connection', ws, req));
  else socket.destroy();
});

// Heartbeat: a powered-off / network-dropped peer leaves a half-open socket that
// the OS won't time out for ~hours. Ping every interval and terminate anything
// that didn't pong since the last one, so a dead agent is marked offline (and a
// dead browser tab cleaned up) within ~one interval instead of hours.
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 30000;
function markAlive() { this.isAlive = true; }
const heartbeat = setInterval(() => {
  for (const wss of [wssAgent, wssBrowser]) {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket already gone */ }
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

// --- agent connections (machine-token auth) --------------------------------
wssAgent.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const machineId = url.searchParams.get('machine');
  const token = url.searchParams.get('token');
  const rec = machines.find((m) => m.id === machineId);
  if (!rec || sha256(token) !== rec.tokenHash) { ws.close(4001, 'bad agent token'); return; }

  ws.isAlive = true; ws.on('pong', markAlive);
  const a = agentState(machineId);
  const prev = a.ws;
  a.ws = ws; a.online = true;
  if (prev && prev !== ws && prev.readyState === WebSocket.OPEN) {
    try { prev.close(4000, 'superseded'); } catch { /* already gone */ }
  }
  // The agent re-sends each live session's full scrollback right after connecting,
  // so drop any stale cache first to avoid doubling the history on reconnect.
  a.replay.clear();
  console.log(`agent online: ${rec.name} (${machineId})`);

  ws.on('message', (raw, isBinary) => {
    if (a.ws !== ws) return; // ignore frames from a superseded duplicate agent connection
    if (isBinary) {
      const { sid, data } = decodeData(Buffer.from(raw));
      let buf = a.replay.get(sid) || Buffer.alloc(0);
      buf = Buffer.concat([buf, data]);
      if (buf.length > SCROLLBACK) buf = buf.subarray(buf.length - SCROLLBACK);
      a.replay.set(sid, buf);
      for (const b of browsersFor(machineId, sid)) if (b.readyState === WebSocket.OPEN) b.send(data);
      return;
    }
    let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (m.t === 'sessions') { a.sessions = m.sessions || []; pruneAliases(machineId, new Set(a.sessions.map((s) => s.id))); return; }
    if (m.t === 'created') {
      const p = a.pending.get(m.reqId);
      if (p) { clearTimeout(p.timer); a.pending.delete(m.reqId); p.resolve(m.session); }
      return;
    }
    if (m.t === 'exit') {
      for (const b of browsersFor(machineId, m.sid)) if (b.readyState === WebSocket.OPEN) b.send(JSON.stringify({ type: 'exit', code: m.code }));
      a.replay.delete(m.sid);
    }
  });

  ws.on('close', () => {
    if (a.ws !== ws) return;
    a.ws = null; a.online = false; // keep replay cache so browsers reattach instantly on reconnect
    // Tell any browsers attached to this machine that it dropped, then close them
    // so the UI shows "offline" instead of a silently frozen terminal.
    for (const [k, set] of browsers) {
      if (!k.startsWith(`${machineId}:`)) continue;
      for (const b of set) if (b.readyState === WebSocket.OPEN) {
        b.send(JSON.stringify({ type: 'error', message: '机器已离线' }));
        b.close(4004, 'machine offline');
      }
    }
    console.log(`agent offline: ${rec.name} (${machineId})`);
  });
  ws.on('error', () => ws.close());
});

// --- browser connections (relay to the chosen machine) ---------------------
wssBrowser.on('connection', (ws, req) => {
  const user = auth.getUser(req);
  if (!user) { ws.close(4001, 'unauthorized'); return; }
  const url = new URL(req.url, 'http://x');
  const mid = url.searchParams.get('agent');
  const sid = url.searchParams.get('session');
  const a = agents.get(mid);
  if (!a || !a.online || !a.ws) { ws.send(JSON.stringify({ type: 'error', message: 'machine offline' })); ws.close(4004, 'offline'); return; }

  ws.isAlive = true; ws.on('pong', markAlive);
  addBrowser(mid, sid, ws);
  const cached = a.replay.get(sid);
  if (cached && cached.length) ws.send(stripReplayQueries(cached)); // current screen, minus reply-triggering queries

  ws.on('message', (raw, isBinary) => {
    if (!a.ws || a.ws.readyState !== WebSocket.OPEN) return;
    if (!isBinary) {
      const text = raw.toString('utf8');
      if (text.startsWith('{')) {
        try {
          const msg = JSON.parse(text);
          if (msg.type === 'resize') return a.ws.send(JSON.stringify({ t: 'resize', sid, cols: msg.cols, rows: msg.rows }));
          if (msg.type === 'input' && typeof msg.data === 'string') return a.ws.send(encodeData(sid, Buffer.from(msg.data)));
        } catch { /* raw keystrokes */ }
      }
      return a.ws.send(encodeData(sid, Buffer.from(text)));
    }
    a.ws.send(encodeData(sid, Buffer.from(raw)));
  });
  ws.on('close', () => removeBrowser(mid, sid, ws));
  ws.on('error', () => removeBrowser(mid, sid, ws));
});

server.listen(PORT, HOST, () => {
  const nets = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log('zsh-web HUB running.');
  console.log(`  local:   http://${HOST}:${PORT}`);
  for (const ip of nets) console.log(`  network: http://${ip}:${PORT}`);
  console.log(`  auth:    ${auth.enabled ? 'ENABLED' : 'OFF'}   oauth2: ${oauthCfg.enabled ? 'configured' : 'off'}`);
  console.log(`  machines registered: ${machines.length}`);
});
