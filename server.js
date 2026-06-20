import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { SessionManager } from './sessions.js';
import { createAuth, attachOAuth2, oauth2ConfigFromEnv } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 7654;
const HOST = process.env.HOST || '127.0.0.1';

const sessions = new SessionManager();
const oauthCfg = oauth2ConfigFromEnv();
const auth = createAuth({ extraEnabled: oauthCfg.enabled });

const app = express();
app.use(express.json());

// --- Auth routes -----------------------------------------------------------
// Token login is for the local CLI client only. A genuine local request is on
// the loopback interface AND carries no reverse-proxy headers; anything coming
// through Lucky (public/LAN) is rejected here and must use OAuth2 instead.
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
  res.json({ ok: true, token, user }); // token returned for programmatic (CLI) clients
});

app.post('/api/logout', (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

app.get('/api/me', auth.requireAuth, (req, res) => {
  res.json({ user: req.user, authEnabled: auth.enabled, oauth2: oauthCfg.enabled });
});

attachOAuth2(app, auth, oauthCfg);

// --- Session management API (all require auth) -----------------------------
app.get('/api/sessions', auth.requireAuth, (_req, res) => {
  res.json({ sessions: sessions.list() });
});

app.post('/api/sessions', auth.requireAuth, (req, res) => {
  const s = sessions.create(req.body && req.body.name);
  res.status(201).json({ session: s.info() });
});

app.delete('/api/sessions/:id', auth.requireAuth, (req, res) => {
  const ok = sessions.kill(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

// --- Claude usage (forwarded to a separate usage service) ------------------
// Usage logic lives in its own process (usage-server.js) so it can be changed
// and restarted without killing the terminal PTYs held in THIS process. The
// front door only authenticates the browser, then forwards to the loopback
// usage service; CC_MONITOR_KEY stays over there, never here.
const USAGE_API_URL = (process.env.USAGE_API_URL || 'http://127.0.0.1:7655').replace(/\/$/, '');

app.use('/api/usage', auth.requireAuth, async (req, res) => {
  const suffix = req.path === '/' ? '' : req.path; // '' for /api/usage, '/refresh' for the refresh call
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  try {
    const r = await fetch(`${USAGE_API_URL}/api/usage${suffix}`, {
      method: req.method,
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(req.body || {}) : undefined,
      signal: AbortSignal.timeout(30000), // refresh re-calls upstream per account; give it room
    });
    res.status(r.status).type('application/json').send(await r.text());
  } catch (e) {
    res.status(502).json({ error: `usage service unreachable: ${String(e.message || e)}` });
  }
});

// Static web UI (pages are public; the API + WS below are what's protected).
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// --- WebSocket: attach a client to a specific session ----------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const user = auth.getUser(req);
  if (!user) {
    ws.close(4001, 'unauthorized');
    return;
  }
  const url = new URL(req.url, 'http://x');
  const session = sessions.get(url.searchParams.get('session'));
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'no such session' }));
    ws.close(4004, 'no session');
    return;
  }

  session.attach(ws);

  ws.on('message', (raw, isBinary) => {
    if (!isBinary) {
      const text = raw.toString('utf8');
      if (text.startsWith('{')) {
        try {
          const msg = JSON.parse(text);
          if (msg.type === 'resize') return session.resize(msg.cols, msg.rows);
          if (msg.type === 'input' && typeof msg.data === 'string') return session.write(msg.data);
        } catch { /* treat as raw keystrokes */ }
      }
      return session.write(text);
    }
    session.write(raw.toString('utf8'));
  });

  ws.on('close', () => session.detach(ws));
  ws.on('error', () => session.detach(ws));
});

// Flush all sessions to disk on shutdown so their history survives the restart.
// We exit synchronously after flushing, before the child PTYs' onExit fires, so
// the persisted files are kept (not treated as a session ending).
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { sessions.shutdown(); } catch { /* best-effort */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => {
  const nets = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log('zsh-web (multi-session) running.');
  console.log(`  local:   http://${HOST}:${PORT}`);
  for (const ip of nets) console.log(`  network: http://${ip}:${PORT}`);
  console.log(`  auth:    ${auth.enabled ? 'ENABLED' : 'OFF (no AUTH_TOKEN / OAuth2 configured)'}`);
  console.log(`  oauth2:  ${oauthCfg.enabled ? 'configured' : 'not configured'}`);
});
