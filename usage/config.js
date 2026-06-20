import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Config for the Claude-usage module (moved in from the standalone cc-monitor).
// All outbound calls to Anthropic can be routed through an HTTPS proxy; we accept
// the common env names so it "just works" on a NAS behind a proxy.
const proxyUrl =
  process.env.CC_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy ||
  '';

// Default the data dir next to this package so it works in dev without env vars.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

export const config = {
  dataDir,
  accountsFile: path.join(dataDir, 'accounts.json'),
  proxyUrl,
  // Usage comes from rate-limit response headers (not the throttled /usage
  // endpoint), so frequent polling is fine — cost is ~1 Haiku token per poll.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 5 * 60 * 1000), // 5 min
  // Floor between automatic fetches for the same account. Manual refresh bypasses it.
  minFetchGapMs: Number(process.env.MIN_FETCH_GAP_MS || 60 * 1000), // 60 s
  // Refresh the access token this long before it actually expires.
  tokenRefreshSkewMs: 5 * 60 * 1000,
};

// Claude Code's public OAuth client (PKCE, no secret). Manual-paste flow, per
// binary analysis of Claude Code: everything on platform.claude.com, scope
// WITHOUT org:create_api_key, token exchange body is x-www-form-urlencoded.
// The browser flow is fragile; importing a setup-token / credentials.json is the
// recommended, reliable alternative.
export const oauth = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://platform.claude.com/oauth/authorize',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  tokenEndpoints: [
    { url: 'https://platform.claude.com/v1/oauth/token', form: true },
    { url: 'https://console.anthropic.com/v1/oauth/token', form: false },
  ],
  scope: 'user:inference user:profile user:sessions:claude_code user:mcp_servers',
  manualCodeParam: true,

  // Usage is read from the `anthropic-ratelimit-unified-*` headers of a minimal
  // Claude Code request — NOT the heavily rate-limited /api/oauth/usage.
  messagesUrl: 'https://api.anthropic.com/v1/messages',
  messagesBeta: 'claude-code-20250219,oauth-2025-04-20',
  userAgent: 'claude-cli/2.1.181 (external, cli)',
  systemPrompt: "You are Claude Code, Anthropic's official CLI for Claude.",
  // Tried in order; accounts may lack a given model (404 → next).
  usageModels: ['claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022'],
};
