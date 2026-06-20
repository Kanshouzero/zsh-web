import { config, oauth } from './config.js';
import { httpFetch } from './http.js';
import { getValidAccessToken } from './oauth.js';
import { listAccounts, getAccount, updateAccount } from './store.js';

// We read usage from the `anthropic-ratelimit-unified-*` response headers of a
// minimal /v1/messages call (1 token of Haiku). This is how Claude Code itself
// learns the limits, and unlike /api/oauth/usage it isn't aggressively rate
// limited. Cost per poll is negligible.
function num(h, k) {
  const v = h.get(k);
  return v == null || v === '' ? null : Number(v);
}

function readWindow(h, prefix) {
  const util = num(h, `anthropic-ratelimit-unified-${prefix}-utilization`);
  if (util == null) return null;
  const reset = num(h, `anthropic-ratelimit-unified-${prefix}-reset`); // unix seconds
  return {
    // utilization is a 0..1 fraction (0.53 = 53%); convert to a percent.
    usedPercent: Math.round(util * 1000) / 10,
    resetsAt: reset ? new Date(reset * 1000).toISOString() : null,
    status: h.get(`anthropic-ratelimit-unified-${prefix}-status`) || null,
  };
}

function readUsageHeaders(h) {
  const raw = {};
  for (const [k, v] of h) if (k.startsWith('anthropic-ratelimit-')) raw[k] = v;
  return {
    fetchedAt: Date.now(),
    fiveHour: readWindow(h, '5h'),
    sevenDay: readWindow(h, '7d'),
    sevenDaySonnet: null,
    overallStatus: h.get('anthropic-ratelimit-unified-status') || null,
    raw,
  };
}

/**
 * Fetch usage for one account via a 1-token Claude Code request, reading the
 * rate-limit headers. Honors a per-account min-gap and a backoff on real 429s.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function refreshAccountUsage(id, { force = false } = {}) {
  const account = getAccount(id);
  if (!account) return { ok: false, reason: 'not found' };

  const now = Date.now();
  if (!force && account.backoffUntil > now) return { ok: false, reason: 'backoff' };
  if (!force && account.lastFetchedAt && now - account.lastFetchedAt < config.minFetchGapMs) {
    return { ok: false, reason: 'too soon' };
  }

  let token;
  try {
    token = await getValidAccessToken(account, (patch) => updateAccount(id, patch));
  } catch (e) {
    updateAccount(id, { lastError: e.message });
    return { ok: false, reason: e.message };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': oauth.messagesBeta,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'user-agent': oauth.userAgent,
  };

  let res;
  let lastErr = null;
  // Try the candidate models in order; an account may lack a given one (404).
  for (const model of oauth.usageModels) {
    const body = JSON.stringify({
      model,
      max_tokens: 1,
      system: oauth.systemPrompt,
      messages: [{ role: 'user', content: 'hi' }],
    });
    try {
      res = await httpFetch(oauth.messagesUrl, { method: 'POST', headers, body });
    } catch (e) {
      lastErr = `network: ${e.message}`;
      res = null;
      continue;
    }
    if (res.status === 404) {
      lastErr = `model ${model} unavailable`;
      continue; // try next model
    }
    break;
  }

  if (!res) {
    updateAccount(id, { lastError: lastErr || 'request failed' });
    return { ok: false, reason: lastErr || 'no response' };
  }

  if (res.status === 429) {
    // A 429 is what we get once a window is exhausted — but the response still
    // carries the `anthropic-ratelimit-*` headers, so read them: that's how the UI
    // keeps showing the real utilization (≈100%) and the reset countdown instead
    // of freezing on stale data and looking broken.
    const usage = readUsageHeaders(res.headers);
    const hasUsage = !!(usage.fiveHour || usage.sevenDay);

    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    let until = Date.now() + (retryAfter > 0 ? retryAfter * 1000 + 30_000 : 10 * 60 * 1000);
    // Don't back off past the 5h window's reset: once it rolls over the account
    // has quota again, so we should resume probing right after. `min` only ever
    // pulls the next probe *earlier*, never later.
    const resetsAt = usage.fiveHour?.resetsAt || account.usage?.fiveHour?.resetsAt;
    if (resetsAt) {
      const resetMs = new Date(resetsAt).getTime() + 30_000;
      if (resetMs > Date.now()) until = Math.min(until, resetMs);
    }

    updateAccount(id, {
      backoffUntil: until,
      // If we got real usage headers this isn't an error state — it's just "maxed
      // out, waiting for reset" — so clear lastError and let the card render normally.
      ...(hasUsage
        ? { usage, lastFetchedAt: Date.now(), lastError: null }
        : { lastError: `请求被限流(429)，${Math.round((until - Date.now()) / 60000)} 分钟后重试` }),
    });
    return { ok: hasUsage, reason: '429' };
  }

  // Even on a non-2xx (e.g. usage exhausted → 403), the rate-limit headers are
  // usually still present, so read them before treating it as an error.
  const usage = readUsageHeaders(res.headers);
  if (!usage.fiveHour && !usage.sevenDay) {
    const text = await res.text().catch(() => '');
    updateAccount(id, { lastError: `HTTP ${res.status}: ${text.slice(0, 200)}` });
    return { ok: false, reason: `HTTP ${res.status}` };
  }

  updateAccount(id, {
    usage,
    subscriptionType: account.subscriptionType,
    lastFetchedAt: Date.now(),
    lastError: null,
    backoffUntil: 0,
  });
  return { ok: true };
}

let timer = null;
export function startPoller() {
  const tick = async () => {
    for (const a of listAccounts()) {
      await refreshAccountUsage(a.id).catch(() => {});
    }
  };
  // Initial pass shortly after boot, then on the slow interval.
  setTimeout(tick, 5000);
  timer = setInterval(tick, config.pollIntervalMs);
  console.log(`[usage] poller every ${Math.round(config.pollIntervalMs / 60000)}m`);
}

export function stopPoller() {
  if (timer) clearInterval(timer);
}
