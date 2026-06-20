#!/usr/bin/env node
// zsh-web Agent. Runs on each computer you want to reach. It dials OUT to the
// Hub over a WebSocket (NAT-friendly: only the Hub needs to be reachable), then
// owns the local zsh PTYs and bridges their I/O to the Hub, multiplexed over
// that one connection.
//
//   node agent.js pair <code>     pair this machine with the Hub (one time)
//   node agent.js                 run the agent (after pairing)
//   node agent.js --name foo      override the machine name on pairing
//
// Config (env):
//   HUB_URL       http(s)/ws(s) base of the Hub, e.g. http://your-hub-host:7654
//   MACHINE_NAME  display name for this machine (default: hostname)
//   AGENT_STORE   credential file (default: ~/.zshweb-agent.json)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { SessionManager } from './sessions.js';
import { encodeData, decodeData } from './wire.js';

const HUB_URL = (process.env.HUB_URL || 'http://127.0.0.1:7654').replace(/\/$/, '');
const STORE = process.env.AGENT_STORE || path.join(os.homedir(), '.zshweb-agent.json');
const args = process.argv.slice(2);
const nameIdx = args.indexOf('--name');
const cliName = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
const defaultName = cliName || process.env.MACHINE_NAME || os.hostname();

const httpBase = HUB_URL.replace(/^ws/, 'http');
const wsBase = HUB_URL.replace(/^http/, 'ws');

function loadCreds() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return null; }
}
function saveCreds(c) {
  fs.writeFileSync(STORE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

// --- pairing ---------------------------------------------------------------
async function pair(code) {
  if (!code) { console.error('用法: node agent.js pair <配对码>'); process.exit(1); }
  const res = await fetch(`${httpBase}/agent/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name: defaultName }),
  });
  if (!res.ok) {
    console.error(`配对失败 (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const { machineId, name, token } = await res.json();
  saveCreds({ machineId, name, token, hub: HUB_URL });
  console.log(`✅ 已配对为「${name}」(${machineId})，凭据已存到 ${STORE}`);
  console.log('现在可以直接运行  node agent.js  让它常驻上线。');
}

// --- run -------------------------------------------------------------------
// A synthetic "client" that the SessionManager broadcasts to, just like a real
// browser WebSocket — except it forwards everything to the Hub, tagged by sid.
class HubBridge {
  constructor(agent, sid) {
    this.agent = agent;
    this.sid = sid;
    this.OPEN = 1;
    this.readyState = 1; // always "open" so Session keeps feeding us; send() no-ops if the Hub is down
  }
  send(data) {
    const hub = this.agent.hub;
    if (!hub || hub.readyState !== WebSocket.OPEN) return;
    if (typeof data === 'string') {
      // Session emits JSON control like {"type":"exit","code":0}
      try { const m = JSON.parse(data); hub.send(JSON.stringify({ ...m, t: m.type, sid: this.sid })); } catch { /* ignore */ }
    } else {
      hub.send(encodeData(this.sid, Buffer.from(data)));
    }
  }
  close() {}
}

class Agent {
  constructor(creds) {
    this.creds = creds;
    this.hub = null;
    this.backoff = 1000;
    this.bridges = new Map(); // sid -> HubBridge
    this.tracked = new Set(); // sids whose exit already notifies the Hub
    this.mgr = new SessionManager();
    // Notify the Hub whenever a session ends — for new sessions AND ones that
    // were restored from disk after an agent restart.
    const origCreate = this.mgr.create.bind(this.mgr);
    this.mgr.create = (name) => this._track(origCreate(name));
    for (const s of this.mgr.sessions.values()) this._track(s);
  }

  _track(s) {
    if (!this.tracked.has(s.id)) {
      this.tracked.add(s.id);
      s.pty.onExit(() => { this.tracked.delete(s.id); this.pushSessions(); });
    }
    return s;
  }

  connect() {
    const url = `${wsBase}/agent?token=${encodeURIComponent(this.creds.token)}` +
      `&machine=${encodeURIComponent(this.creds.machineId)}`;
    const hub = new WebSocket(url);
    this.hub = hub;
    let hb = null;

    hub.isAlive = true;
    hub.on('pong', () => { hub.isAlive = true; });

    hub.on('open', () => {
      this.backoff = 1000;
      console.log(`● 已连上 Hub ${HUB_URL} as ${this.creds.name}`);
      // Heartbeat: if the Hub dies abruptly (power off / crash), no close event
      // arrives — so ping it and tear down a connection that stops ponging, which
      // triggers our reconnect below instead of hanging on a half-open socket.
      hb = setInterval(() => {
        if (hub.isAlive === false) return hub.terminate();
        hub.isAlive = false;
        try { hub.ping(); } catch { /* gone */ }
      }, 30000);
      // Re-bridge every existing session (sends each one's replay to seed the Hub cache).
      for (const s of this.mgr.sessions.values()) this._bridge(s);
      this.pushSessions();
    });

    hub.on('message', (raw, isBinary) => {
      if (isBinary) {
        const { sid, data } = decodeData(Buffer.from(raw));
        const s = this.mgr.get(sid);
        if (s) s.write(data.toString('utf8')); // keyboard input from a browser
        return;
      }
      let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
      this._control(m);
    });

    const drop = () => {
      if (this.hub !== hub) return;
      if (hb) clearInterval(hb);
      this.hub = null;
      for (const b of this.bridges.values()) { const s = this.mgr.get(b.sid); if (s) s.detach(b); }
      this.bridges.clear();
      console.error(`Hub 断开,${this.backoff}ms 后重连…`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    };
    hub.on('close', drop);
    hub.on('error', () => hub.close());
  }

  _bridge(s) {
    if (this.bridges.has(s.id)) return;
    const b = new HubBridge(this, s.id);
    this.bridges.set(s.id, b);
    s.attach(b); // immediately replays this session's scrollback up to the Hub
  }

  _control(m) {
    switch (m.t) {
      case 'create': {
        const s = this.mgr.create(m.name);
        this._bridge(s);
        if (this.hub) this.hub.send(JSON.stringify({ t: 'created', reqId: m.reqId, session: s.info() }));
        this.pushSessions();
        break;
      }
      case 'kill': {
        this.mgr.kill(m.sid);
        this.pushSessions();
        break;
      }
      case 'resize': {
        const s = this.mgr.get(m.sid);
        if (s) s.resize(m.cols, m.rows);
        break;
      }
      default: break;
    }
  }

  pushSessions() {
    if (this.hub && this.hub.readyState === WebSocket.OPEN) {
      this.hub.send(JSON.stringify({ t: 'sessions', sessions: this.mgr.list() }));
    }
  }
}

// --- main ------------------------------------------------------------------
(async function main() {
  if (args[0] === 'pair') return pair(args[1]);

  const creds = loadCreds();
  if (!creds || !creds.token) {
    console.error('尚未配对。先在网页点「添加机器」拿配对码,然后运行:');
    console.error('  node agent.js pair <配对码>');
    process.exit(1);
  }
  console.log(`zsh-web agent「${creds.name}」启动,目标 Hub ${HUB_URL}`);
  const agent = new Agent(creds);

  // Graceful stop (launchd sends SIGTERM): flush every session to disk and flag
  // that the PTYs are dying because WE are, so their store files are kept for the
  // next start to restore — not deleted as "the shell ended".
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; try { agent.mgr.shutdown(); } catch { /* best-effort */ } process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  agent.connect();
})();
