import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { config } from './usage/config.js';
import * as store from './usage/store.js';
import { buildLogin, exchangeCode, parseImport } from './usage/oauth.js';
import { refreshAccountUsage, startPoller } from './usage/core.js';

// Self-contained Claude-usage service (moved in from the standalone cc-monitor):
// it now OWNS the account credentials, the Anthropic OAuth flow and the usage
// poller. It binds to loopback only and is reached exclusively through hub.js's
// authenticated `/api/usage` proxy (which forwards method + path + body), so it
// performs no auth of its own. Every route lives under /api/usage to match that
// proxy prefix.
const PORT = Number(process.env.PORT) || 7655;
const HOST = process.env.HOST || '127.0.0.1';

store.load();

const app = express();
app.use(express.json({ limit: '64kb' }));

// Pending OAuth logins (PKCE verifier + state), keyed by an opaque id handed to
// the browser. Short-lived, in memory.
const pending = new Map();
function gcPending() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > 15 * 60 * 1000) pending.delete(k);
}

// ---- read: cached usage list (fast) ----
app.get('/api/usage', (_req, res) => {
  res.json({ accounts: store.listAccounts().map(store.publicView) });
});

// ---- force re-pull every account from upstream, then return fresh data ----
app.post('/api/usage/refresh', async (_req, res) => {
  await Promise.allSettled(
    store.listAccounts().map((a) => refreshAccountUsage(a.id, { force: true })),
  );
  res.json({ accounts: store.listAccounts().map(store.publicView) });
});

// ---- add account: start the Anthropic OAuth (returns authorize URL) ----
app.post('/api/usage/accounts/login/start', (_req, res) => {
  gcPending();
  const { url, verifier, state } = buildLogin();
  const pendingId = crypto.randomUUID();
  pending.set(pendingId, { verifier, state, createdAt: Date.now() });
  res.json({ pendingId, authorizeUrl: url });
});

// ---- add account: finish OAuth (exchange the pasted code) ----
app.post('/api/usage/accounts/login/complete', async (req, res) => {
  const { pendingId, code, name } = req.body || {};
  const p = pending.get(pendingId);
  if (!p) return res.status(400).json({ error: '登录会话已过期，请重新开始' });
  try {
    const tokens = await exchangeCode(code, p.verifier);
    pending.delete(pendingId);
    const account = store.addAccount({ ...tokens, name });
    refreshAccountUsage(account.id, { force: true }).catch(() => {});
    res.json({ ok: true, account: store.publicView(account) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- add account: reliable import (paste a setup-token / credentials.json) ----
app.post('/api/usage/accounts/import', async (req, res) => {
  try {
    const tokens = parseImport(req.body?.raw);
    const account = store.addAccount({ ...tokens, name: req.body?.name });
    refreshAccountUsage(account.id, { force: true }).catch(() => {});
    res.json({ ok: true, account: store.publicView(account) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- refresh one account now ----
app.post('/api/usage/accounts/:id/refresh', async (req, res) => {
  const result = await refreshAccountUsage(req.params.id, { force: true });
  const account = store.getAccount(req.params.id);
  res.json({ ...result, account: account ? store.publicView(account) : null });
});

// ---- rename ----
app.patch('/api/usage/accounts/:id', (req, res) => {
  const name = String(req.body?.name || '').slice(0, 60);
  const account = store.updateAccount(req.params.id, name ? { name } : {});
  if (!account) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, account: store.publicView(account) });
});

// ---- delete ----
app.delete('/api/usage/accounts/:id', (req, res) => {
  res.json({ ok: store.removeAccount(req.params.id) });
});

http.createServer(app).listen(PORT, HOST, () => {
  console.log(`zsh-web usage service running at http://${HOST}:${PORT}`);
  console.log(`  data:  ${config.accountsFile}`);
  console.log(`  proxy: ${config.proxyUrl || '(none)'}`);
  console.log(`  accounts: ${store.listAccounts().length}`);
  startPoller();
});
