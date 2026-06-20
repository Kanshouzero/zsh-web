import { ProxyAgent } from 'undici';
import { config } from './config.js';

// A single shared dispatcher so all outbound requests reuse the proxy tunnel.
const dispatcher = config.proxyUrl ? new ProxyAgent(config.proxyUrl) : undefined;

if (config.proxyUrl) {
  console.log(`[usage:http] outbound requests routed through proxy: ${config.proxyUrl}`);
} else {
  console.log('[usage:http] no proxy configured (set CC_PROXY / HTTPS_PROXY to use one)');
}

/** fetch wrapper that injects the proxy dispatcher and a timeout. */
export async function httpFetch(url, opts = {}) {
  const { timeoutMs = 20000, ...rest } = opts;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, dispatcher, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}
