import crypto from 'node:crypto';

// Pluggable auth. Today: a shared token -> signed-cookie session.
// Every provider (token now, OAuth2 later) ends the same way: it verifies a
// user, then calls `issueSession(res, user)`. Adding OAuth2 means wiring a new
// route that calls issueSession — nothing else in the app changes.

export function oauth2ConfigFromEnv() {
  const clientId = process.env.OAUTH2_CLIENT_ID;
  return {
    enabled: !!(
      clientId &&
      process.env.OAUTH2_CLIENT_SECRET &&
      process.env.OAUTH2_AUTH_URL &&
      process.env.OAUTH2_TOKEN_URL &&
      process.env.OAUTH2_USERINFO_URL &&
      process.env.OAUTH2_REDIRECT_URI
    ),
    clientId,
    clientSecret: process.env.OAUTH2_CLIENT_SECRET,
    authUrl: process.env.OAUTH2_AUTH_URL,
    tokenUrl: process.env.OAUTH2_TOKEN_URL,
    userInfoUrl: process.env.OAUTH2_USERINFO_URL,
    redirectUri: process.env.OAUTH2_REDIRECT_URI,
    scope: process.env.OAUTH2_SCOPE || 'openid email profile',
  };
}

export function createAuth(opts = {}) {
  const token = opts.token ?? process.env.AUTH_TOKEN ?? '';
  const secret = opts.secret || process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
  const ttlMs = opts.ttlMs || 7 * 24 * 3600 * 1000;
  // Auth is ON if any provider is configured. With nothing configured we stay
  // OFF so localhost dev "just works".
  const enabled = !!token || !!opts.extraEnabled;

  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  function verify(tok) {
    if (!tok || typeof tok !== 'string' || !tok.includes('.')) return null;
    const [body, mac] = tok.split('.');
    const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (p.exp && Date.now() > p.exp) return null;
      return p;
    } catch {
      return null;
    }
  }

  function issueSession(res, user) {
    const tok = sign({
      sub: user.id || user.name || 'user',
      name: user.name || user.id || 'user',
      via: user.via || 'token',
      exp: Date.now() + ttlMs,
    });
    res.setHeader('Set-Cookie', `zw_auth=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}`);
    return tok;
  }

  function clearSession(res) {
    res.setHeader('Set-Cookie', 'zw_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  }

  function readToken(req) {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/(?:^|;\s*)zw_auth=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    const authz = req.headers.authorization || '';
    if (authz.startsWith('Bearer ')) return authz.slice(7);
    try {
      const u = new URL(req.url, 'http://x');
      const q = u.searchParams.get('access_token');
      if (q) return q;
    } catch { /* ignore */ }
    return null;
  }

  // Works for both express requests and raw WS upgrade requests.
  function getUser(req) {
    if (!enabled) return { sub: 'local', name: 'local', via: 'none' };
    return verify(readToken(req));
  }

  function requireAuth(req, res, next) {
    const u = getUser(req);
    if (u) {
      req.user = u;
      return next();
    }
    return res.status(401).json({ error: 'unauthorized' });
  }

  // --- Token provider ---
  function tokenLogin(provided) {
    if (!enabled) return { id: 'local', name: 'local', via: 'none' };
    if (!token || !provided) return null;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { id: 'token-user', name: 'token-user', via: 'token' };
  }

  return { enabled, sign, verify, issueSession, clearSession, getUser, requireAuth, tokenLogin };
}

// --- OAuth2 provider (standard authorization-code flow) --------------------
// Mounted only when OAUTH2_* env vars are set. Untested without real client
// credentials, but follows the spec; the success path just calls issueSession.
export function attachOAuth2(app, auth, cfg = oauth2ConfigFromEnv()) {
  if (!cfg.enabled) {
    app.get('/auth/oauth2/login', (_req, res) =>
      res.status(501).send('OAuth2 not configured. Set OAUTH2_* env vars (see README).'));
    return false;
  }

  app.get('/auth/oauth2/login', (_req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `zw_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
    const u = new URL(cfg.authUrl);
    u.searchParams.set('client_id', cfg.clientId);
    u.searchParams.set('redirect_uri', cfg.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', cfg.scope);
    u.searchParams.set('state', state);
    res.redirect(u.toString());
  });

  app.get('/auth/oauth2/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      const cookie = req.headers.cookie || '';
      const m = cookie.match(/zw_oauth_state=([^;]+)/);
      if (!code || !state || !m || m[1] !== state) return res.status(400).send('invalid oauth state');

      const tokenRes = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: cfg.redirectUri,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
        }),
      }).then((r) => r.json());

      if (!tokenRes.access_token) return res.status(401).send('token exchange failed');

      const profile = await fetch(cfg.userInfoUrl, {
        headers: { Authorization: `Bearer ${tokenRes.access_token}` },
      }).then((r) => r.json());

      auth.issueSession(res, {
        id: profile.sub || profile.id || profile.email,
        name: profile.name || profile.username || profile.login || profile.email || 'oauth2-user',
        via: 'oauth2',
      });
      res.redirect('/');
    } catch (e) {
      res.status(500).send(`oauth2 error: ${e.message}`);
    }
  });

  return true;
}
