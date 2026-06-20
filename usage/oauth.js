import crypto from 'node:crypto';
import { config, oauth } from './config.js';
import { httpFetch } from './http.js';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Parse whatever the user pastes into the import box into a token set:
//   - full ~/.claude/.credentials.json (has a claudeAiOauth object)
//   - a JSON object with accessToken/refreshToken/expiresAt
//   - a bare token from `claude setup-token` (sk-ant-oat01-...), treated as a
//     long-lived credential with no refresh token.
export function parseImport(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('内容为空');

  // Bare token.
  if (/^sk-ant-/.test(s) && !s.includes('{')) {
    return {
      accessToken: s,
      refreshToken: null,
      expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
      subscriptionType: null,
    };
  }

  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    throw new Error('无法识别：请粘贴 setup-token 的 sk-ant-oat 令牌，或 credentials.json 内容');
  }
  const o = obj.claudeAiOauth || obj;
  const accessToken = o.accessToken || o.access_token;
  if (!accessToken) throw new Error('未找到 accessToken 字段');
  return {
    accessToken,
    refreshToken: o.refreshToken || o.refresh_token || null,
    expiresAt: o.expiresAt || o.expires_at || Date.now() + 8 * 3600 * 1000,
    subscriptionType: o.subscriptionType || o.subscription_type || null,
  };
}

// Build a PKCE challenge + authorize URL. The verifier/state must be kept
// server-side until the user pastes the code back.
export function buildLogin() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  const url = new URL(oauth.authorizeUrl);
  if (oauth.manualCodeParam) url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', oauth.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', oauth.redirectUri);
  url.searchParams.set('scope', oauth.scope);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return { url: url.toString(), verifier, state };
}

function normalizeTokens(json) {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in || 0) * 1000,
    subscriptionType: json.subscription_type || json.account?.subscription_type || null,
  };
}

// POST a token request, trying each configured endpoint with the content-type
// that host expects (platform.claude.com wants form-urlencoded; the older
// console.anthropic.com wants JSON).
async function postToken(body, label) {
  let lastErr;
  for (const { url, form } of oauth.tokenEndpoints) {
    let res;
    try {
      res = await httpFetch(url, {
        method: 'POST',
        timeoutMs: 120000, // platform endpoint can take 40-60s under load
        headers: {
          'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      });
    } catch (e) {
      lastErr = new Error(`${label} network error at ${url}: ${e.message}`);
      continue;
    }
    const text = await res.text();
    if (res.ok) return normalizeTokens(JSON.parse(text));
    lastErr = new Error(`${label} failed (${res.status}) at ${url}: ${text.slice(0, 200)}`);
    lastErr.status = res.status;
    // A non-429 4xx means this host parsed us but rejected the code/creds —
    // trying the other host with the same input won't help.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
  }
  throw lastErr;
}

// Accept whatever the user can grab after authorizing:
//   - a full redirect URL: http://localhost:45289/callback?code=XXX&state=YYY
//   - the display-page form: CODE#STATE
//   - a bare code
function parseCode(raw) {
  const s = String(raw).trim();
  if (s.includes('://') || s.includes('code=')) {
    try {
      const u = new URL(s.includes('://') ? s : `http://x/?${s}`);
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state') || undefined;
      if (code) return { code, state };
    } catch {
      /* fall through */
    }
  }
  const [code, state] = s.split('#');
  return { code, state: state || undefined };
}

export async function exchangeCode(rawCode, verifier) {
  const { code, state } = parseCode(rawCode);
  const body = {
    grant_type: 'authorization_code',
    code,
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    code_verifier: verifier,
  };
  if (state) body.state = state;
  return postToken(body, 'token exchange');
}

export async function refreshToken(refresh) {
  return postToken(
    {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: oauth.clientId,
    },
    'token refresh',
  );
}

// Returns a valid access token for the account, refreshing + persisting if the
// current one is expired or close to expiry. `persist` saves rotated tokens.
export async function getValidAccessToken(account, persist) {
  const fresh = account.expiresAt - config.tokenRefreshSkewMs > Date.now();
  if (fresh && account.accessToken) return account.accessToken;
  if (!account.refreshToken) {
    throw new Error('no refresh token; please re-login this account');
  }
  const tokens = await refreshToken(account.refreshToken);
  persist({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || account.refreshToken,
    expiresAt: tokens.expiresAt,
    subscriptionType: tokens.subscriptionType || account.subscriptionType,
  });
  return tokens.accessToken;
}
