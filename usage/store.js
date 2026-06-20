import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';

// Simple JSON file store guarded by an in-process write queue. Good enough for
// a personal single-instance tool; the file lives on a mounted volume.

let state = { accounts: [] };

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

export function load() {
  ensureDir();
  try {
    const raw = fs.readFileSync(config.accountsFile, 'utf8');
    state = JSON.parse(raw);
    if (!Array.isArray(state.accounts)) state.accounts = [];
  } catch {
    state = { accounts: [] };
  }
  return state;
}

let saving = Promise.resolve();
export function save() {
  ensureDir();
  const tmp = config.accountsFile + '.tmp';
  const data = JSON.stringify(state, null, 2);
  // Serialize writes and write-then-rename for atomicity.
  saving = saving.then(
    () =>
      new Promise((resolve) => {
        fs.writeFile(tmp, data, (err) => {
          if (err) {
            console.error('[usage:store] write failed:', err.message);
            return resolve();
          }
          fs.rename(tmp, config.accountsFile, (err2) => {
            if (err2) console.error('[usage:store] rename failed:', err2.message);
            resolve();
          });
        });
      }),
  );
  return saving;
}

export function listAccounts() {
  return state.accounts;
}

export function getAccount(id) {
  return state.accounts.find((a) => a.id === id);
}

export function addAccount(partial) {
  const account = {
    id: crypto.randomUUID(),
    name: partial.name || 'Claude Code',
    accessToken: partial.accessToken,
    refreshToken: partial.refreshToken,
    expiresAt: partial.expiresAt || 0,
    subscriptionType: partial.subscriptionType || null,
    addedAt: Date.now(),
    usage: null, // last successful usage payload (normalized)
    lastFetchedAt: 0,
    lastError: null,
    backoffUntil: 0,
  };
  state.accounts.push(account);
  save();
  return account;
}

export function updateAccount(id, patch) {
  const a = getAccount(id);
  if (!a) return null;
  Object.assign(a, patch);
  save();
  return a;
}

export function removeAccount(id) {
  const i = state.accounts.findIndex((a) => a.id === id);
  if (i === -1) return false;
  state.accounts.splice(i, 1);
  save();
  return true;
}

// Public-safe view of an account (no tokens leak to the browser).
export function publicView(a) {
  return {
    id: a.id,
    name: a.name,
    subscriptionType: a.subscriptionType,
    addedAt: a.addedAt,
    usage: a.usage,
    lastFetchedAt: a.lastFetchedAt,
    lastError: a.lastError,
    tokenExpiresAt: a.expiresAt,
  };
}
