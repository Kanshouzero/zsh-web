import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHELL = process.env.SHELL || '/bin/zsh';
const SCROLLBACK = Number(process.env.SCROLLBACK) || 200_000; // replay bytes per session
const STORE_DIR = process.env.SESSION_DIR || path.join(__dirname, '.sessions');
const PERSIST_MS = Number(process.env.PERSIST_MS) || 2000; // throttle disk writes

try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch { /* best-effort */ }

// Set when the whole server is going down (SIGTERM/SIGINT). During shutdown the
// child PTYs die too and fire onExit — but that's NOT the session ending, so we
// must keep the persisted files around for the next start to restore.
let SHUTTING_DOWN = false;

const RESTORE_MARK = Buffer.from(
  '\r\n\x1b[2m── 历史输出到此为止;服务已重启,以下是新的 shell 进程 ──\x1b[0m\r\n',
);

// One shared zsh PTY. Multiple clients attach to the same Session and stay
// byte-for-byte in sync; the SessionManager lets you run several independent ones.
// The replay buffer is persisted to disk so its history survives a server
// restart — note the shell process itself is always new after a restart.
export class Session {
  constructor(name, restore = null) {
    if (restore) {
      this.id = restore.id;
      this.name = restore.name || `session-${this.id}`;
      this.createdAt = restore.createdAt || Date.now();
      // Old history + a marker; the fresh shell's output appends after it.
      this.replay = Buffer.concat([restore.replay || Buffer.alloc(0), RESTORE_MARK]);
    } else {
      this.id = randomUUID().slice(0, 8);
      this.name = name || `session-${this.id}`;
      this.createdAt = Date.now();
      this.replay = Buffer.alloc(0);
    }
    this.cols = 80;
    this.rows = 24;
    this.clients = new Set();
    this.exited = false;
    this.exitCode = null;
    this._persistTimer = null;
    this._persistDirty = false;

    this.pty = pty.spawn(SHELL, ['-l'], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: process.env.HOME,
      env: process.env,
    });

    this.pty.onData((data) => {
      const buf = Buffer.from(data, 'utf8');
      this.replay = Buffer.concat([this.replay, buf]);
      if (this.replay.length > SCROLLBACK) {
        this.replay = this.replay.subarray(this.replay.length - SCROLLBACK);
      }
      for (const ws of this.clients) {
        if (ws.readyState === ws.OPEN) ws.send(buf);
      }
      this._schedulePersist();
    });

    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      // The shell genuinely ended (user typed exit / was killed) — drop its
      // store file. But if the whole server is shutting down, keep it: the PTY
      // only died because its parent did, and we want to restore next start.
      if (!SHUTTING_DOWN) this._removePersisted();
      for (const ws of this.clients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
          ws.close();
        }
      }
    });

    // Make a brand-new session restorable even before the first throttled flush.
    if (!restore) this._schedulePersist();
  }

  attach(ws) {
    this.clients.add(ws);
    if (this.replay.length) ws.send(this.replay); // bring the new client to the current screen
  }

  detach(ws) {
    this.clients.delete(ws);
  }

  write(data) {
    if (!this.exited) this.pty.write(data);
  }

  resize(cols, rows) {
    if (this.exited || !cols || !rows) return;
    this.cols = cols;
    this.rows = rows;
    try { this.pty.resize(cols, rows); } catch { /* shell may be gone */ }
  }

  kill() {
    try { this.pty.kill(); } catch { /* already dead */ }
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      clients: this.clients.size,
      cols: this.cols,
      rows: this.rows,
      exited: this.exited,
      exitCode: this.exitCode,
    };
  }

  // --- persistence ---------------------------------------------------------
  get _storeFile() {
    return path.join(STORE_DIR, `${this.id}.json`);
  }

  _schedulePersist() {
    this._persistDirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      if (this._persistDirty) this.persistNow();
    }, PERSIST_MS);
  }

  // Write the replay buffer to disk atomically (temp file + rename). Best-effort:
  // a disk hiccup must never crash a live shell.
  persistNow() {
    this._persistDirty = false;
    const payload = JSON.stringify({
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      replay: this.replay.toString('base64'),
    });
    const tmp = `${this._storeFile}.tmp`;
    try {
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, this._storeFile);
    } catch { /* best-effort */ }
  }

  _removePersisted() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    try { fs.unlinkSync(this._storeFile); } catch { /* already gone */ }
  }
}

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this._restore();
  }

  // Rebuild sessions from disk on startup. Each restored session gets a fresh
  // shell but keeps its old id/name and history.
  _restore() {
    let files = [];
    try {
      files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.json'));
    } catch { return; }
    for (const f of files) {
      const full = path.join(STORE_DIR, f);
      try {
        const data = JSON.parse(fs.readFileSync(full, 'utf8'));
        let replay = Buffer.from(data.replay || '', 'base64');
        if (replay.length > SCROLLBACK) replay = replay.subarray(replay.length - SCROLLBACK);
        const s = new Session(null, { id: data.id, name: data.name, createdAt: data.createdAt, replay });
        this.sessions.set(s.id, s);
        s.pty.onExit(() => setTimeout(() => this.sessions.delete(s.id), 3000));
      } catch {
        // Corrupted store file — move it aside so startup doesn't keep tripping on it.
        try { fs.renameSync(full, `${full}.corrupt`); } catch { /* give up */ }
      }
    }
  }

  create(name) {
    const s = new Session(name);
    this.sessions.set(s.id, s);
    // Keep an exited session around briefly so clients see the exit, then reap it.
    s.pty.onExit(() => setTimeout(() => this.sessions.delete(s.id), 3000));
    return s;
  }

  get(id) {
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()].map((s) => s.info());
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.kill();
    this.sessions.delete(id);
    return true;
  }

  // Called on server shutdown: flush every session to disk synchronously and
  // flag that subsequent PTY exits are shutdown-induced (so their files stay).
  shutdown() {
    SHUTTING_DOWN = true;
    for (const s of this.sessions.values()) s.persistNow();
  }
}
