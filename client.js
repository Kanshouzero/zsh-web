#!/usr/bin/env node
// Local terminal client. Authenticates (if AUTH_TOKEN set), picks/creates a
// session, then attaches your real terminal to that shared zsh session.
//
//   node client.js              create a new session and attach
//   node client.js <sessionId>  attach to an existing session
//   node client.js --list       list sessions and exit
//   node client.js --name foo   create a session named "foo" and attach
//
// Ctrl-] detaches without killing the session.
import WebSocket from 'ws';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT || 7654;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const base = `http://${HOST}:${PORT}`;

const args = process.argv.slice(2);
const wantList = args.includes('--list');
const nameIdx = args.indexOf('--name');
const wantName = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
const sessionArg = args.find((a) => !a.startsWith('--') && a !== wantName);

let accessToken = '';

async function login() {
  if (!AUTH_TOKEN) return; // auth off
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: AUTH_TOKEN }),
  });
  if (!res.ok) throw new Error('login failed (check AUTH_TOKEN)');
  accessToken = (await res.json()).token || '';
}

const authHeaders = () => (accessToken ? { Authorization: `Bearer ${accessToken}` } : {});

async function listSessions() {
  const res = await fetch(`${base}/api/sessions`, { headers: authHeaders() });
  if (res.status === 401) throw new Error('unauthorized');
  return (await res.json()).sessions;
}

async function createSession(name) {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).session;
}

function attach(sessionId) {
  const q = new URLSearchParams({ session: sessionId });
  if (accessToken) q.set('access_token', accessToken);
  const ws = new WebSocket(`ws://${HOST}:${PORT}/ws?${q}`);
  ws.binaryType = 'arraybuffer';

  const sendResize = () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }));
    }
  };

  ws.on('open', () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\x1b[2J\x1b[H');
    sendResize();
    process.stdout.on('resize', sendResize);
    process.stdin.on('data', (chunk) => {
      if (chunk.length === 1 && chunk[0] === 0x1d) return cleanup(0, ws); // Ctrl-]
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });
  });
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const m = JSON.parse(data.toString('utf8'));
        if (m.type === 'exit') { process.stdout.write(`\r\n[shell exited ${m.code}]\r\n`); return cleanup(0, ws); }
        if (m.type === 'error') { process.stderr.write(`\r\n[error] ${m.message}\r\n`); return cleanup(1, ws); }
        return;
      } catch { /* fall through */ }
    }
    process.stdout.write(Buffer.from(data));
  });
  ws.on('close', () => { process.stdout.write('\r\n[disconnected]\r\n'); cleanup(0, ws); });
  ws.on('error', (err) => { process.stderr.write(`\r\n[error] ${err.message}\r\n`); cleanup(1, ws); });
}

function cleanup(code, ws) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  try { ws.close(); } catch { /* ignore */ }
  process.exit(code);
}

(async function main() {
  try {
    await login();
    if (wantList) {
      const sessions = await listSessions();
      if (!sessions.length) console.log('(no sessions)');
      for (const s of sessions) console.log(`${s.id}  ${s.name}  ${s.clients} client(s)${s.exited ? '  [exited]' : ''}`);
      process.exit(0);
    }
    let id = sessionArg;
    if (!id) {
      const s = await createSession(wantName);
      id = s.id;
      console.error(`Created session ${s.id} (${s.name}). Ctrl-] to detach.`);
    } else {
      console.error(`Attaching to ${id}. Ctrl-] to detach.`);
    }
    attach(id);
  } catch (e) {
    console.error(`[error] ${e.message}`);
    process.exit(1);
  }
})();

process.on('SIGINT', () => {}); // let Ctrl-C reach the shell
