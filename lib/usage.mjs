// lib/usage.mjs — multi-provider AI usage/quota adapters (Claude Code, Codex,
// Kimi Code, Gemini/Antigravity).
//
// This file used to hold all four adapters and 1,100 lines of near-identical
// cache/TTL/status scaffolding around them. It is now the public face of
// lib/usage/: one shared harness plus one small file per provider, so a fifth
// provider is ~150 lines of what's actually different about it rather than
// another copy of the plumbing.
//
//   lib/usage/harness.mjs  cache + TTL policy, the never-throw contract, the
//                          `fresh` bypass, backoff/retryAt, root resolution
//   lib/usage/read.mjs     bounded, never-throwing, read-only disk access
//   lib/usage/claude.mjs   the only network adapter — OAuth usage endpoint
//   lib/usage/codex.mjs    newest rollout .jsonl, tail-read
//   lib/usage/kimi.mjs     ~/.kimi-code heartbeat/sessions/wire logs
//   lib/usage/gemini.mjs   ~/.gemini language-server log head+tail, metadata
//
// THE IRON RULES, unchanged and enforced by the harness:
//
//   NEVER THROWS. getClaudeUsage(), getCodexUsage(), getKimiUsage() and
//   getGeminiUsage() must never reject: every failure mode (missing creds,
//   corrupt files, network errors, expired tokens) comes back as a `status`
//   field on the result — ok / error / no-data / not-installed / no-creds /
//   token-expired / rate-limited.
//
//   READ-ONLY. No adapter ever writes to disk, creates a directory, or
//   refreshes a token. Best-effort observation, never management.
//
//   SECRETS ARE NEVER READ AND NEVER LOGGED. Claude never echoes
//   accessToken/refreshToken; Kimi never opens ~/.kimi-code/server.token,
//   credentials/ or oauth/; Gemini never opens antigravity-cli/
//   antigravity-oauth-token and never surfaces the account email its CLI logs.
//
//   SCANS ARE BOUNDED. Kimi substring-filters before JSON.parse (8.8MB of wire
//   logs in ~94ms); Gemini reads a 32KB head plus a 256KB tail and never the
//   whole log; Codex tail-reads anything over 25MB; Claude reads one small
//   JSON file.
//
//   "PUBLISHES NO QUOTA" IS A FIRST-CLASS ANSWER, not a gap. Claude and Codex
//   publish real quota `windows`. Kimi and Gemini publish none — their
//   providers expose no limit, utilization or reset instant anywhere — so they
//   declare `publishesQuota: false` and the harness guarantees `windows: []`.
//   The UI must not invent a gauge for them.
export { parseScopedLimits, getClaudeUsage } from './usage/claude.mjs';
export { codexSessionsRoot, getCodexUsage } from './usage/codex.mjs';
export { kimiRoot, getKimiUsage } from './usage/kimi.mjs';
export { geminiRoot, getGeminiUsage } from './usage/gemini.mjs';
