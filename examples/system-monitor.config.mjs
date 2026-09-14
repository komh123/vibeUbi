/**
 * VibeUbi config for the system-monitor project.
 *
 * Kept OUTSIDE that repository on purpose: `vibeubi scan --config <this>`
 * points a run at a project without writing a single byte into it. That is
 * what you want the first time you scan somebody else's code, and what CI
 * usually wants forever.
 */
import * as express from "../packages/adapters/src/express.plugin.mjs"

const ROOT = "/home/ubuntu/system-monitor"

export default {
  name: "system-monitor",
  plugins: [express],
  pluginConfig: {
    "vibeubi-express": {
      root: ROOT,
      entry: "server/index.js",
      routesDir: "server/routes",
      pagesDir: "client/src/pages",
      versionPath: "/api/version",          // returns the id stamped INTO the artifact
      buildCommand: "npm run build",
      startCommand: "node server/index.js",
      distDir: "dist",
      env: { PORT: "3401", JWT_SECRET: "a-real-secret-for-this-test" },
      startWaitMs: 2500,
    },
  },

  roles: ["guest", "user"],

  /** Auth helpers THIS project uses. Nothing can guess these, and guessing is
   *  how a scanner ends up at 20% precision. */
  gateTokens: ["requireAuth", "authenticate", "verifyToken", "jwt.verify", "req.user", "authMiddleware"],

  base: "http://127.0.0.1:3401",

  /** Offline checks that must pass before anything is built. */
  verify: [
    { name: "unit", cmd: "npx vitest run --reporter=basic", expectsTests: true },
  ],
  layers: ["S0", "S2"],

  declared: [
    {"id":"api:/api/metrics","area":"metrics","kind":"api","priority":"P2","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/logs","area":"logs","kind":"api","priority":"P2","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/processes/:pid/kill","area":"processes","kind":"api","priority":"P0","requiredRole":"admin","source":"server/index.js"},
    {"id":"api:/api/processes/:pid/oom","area":"processes","kind":"api","priority":"P0","requiredRole":"admin","source":"server/index.js"},
    {"id":"api:/api/oom","area":"oom","kind":"api","priority":"P0","requiredRole":"admin","source":"server/index.js"},
    {"id":"api:/api/config","area":"config","kind":"api","priority":"P0","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/refresh","area":"refresh","kind":"api","priority":"P0","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/disk/cleanup","area":"disk","kind":"api","priority":"P0","requiredRole":"admin","source":"server/index.js"},
    {"id":"api:/api/processes/claude-buddy/cleanup","area":"processes","kind":"api","priority":"P0","requiredRole":"admin","source":"server/index.js"},
    {"id":"api:/api/processes/claude-buddy/stats","area":"processes","kind":"api","priority":"P2","requiredRole":"admin","source":"server/index.js"},
    {"id":"api:/api/claude-remote/status","area":"claude-remote","kind":"api","priority":"P2","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/claude-remote/logs","area":"claude-remote","kind":"api","priority":"P2","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/claude-remote/recover/:ip","area":"claude-remote","kind":"api","priority":"P0","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/network-diagnostics/:ip","area":"network-diagnostics","kind":"api","priority":"P1","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/claude-remote/start-session/:ip","area":"claude-remote","kind":"api","priority":"P0","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/claude-remote/restart-session/:ip","area":"claude-remote","kind":"api","priority":"P0","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/claude-remote/reconnect/:ip","area":"claude-remote","kind":"api","priority":"P0","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/claude-remote/session-status/:ip/:sessionName","area":"claude-remote","kind":"api","priority":"P0","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/debug/exec/:ip","area":"debug","kind":"api","priority":"P0","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/claude-remote/health/:ip","area":"claude-remote","kind":"api","priority":"P2","requiredRole":"guest","source":"server/index.js"},
    {"id":"api:/api/claude-remote/test-ssh/:ip","area":"claude-remote","kind":"api","priority":"P0","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/claude-remote/config","area":"claude-remote","kind":"api","priority":"P1","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/health","area":"other","kind":"api","priority":"P2","requiredRole":"guest","source":"server/index.js"},
    {"id":"api:/api/version","area":"version","kind":"api","priority":"P2","requiredRole":"guest","source":"server/index.js"},
    {"id":"api:/api/docs/claude-remote-monitoring","area":"docs","kind":"api","priority":"P2","requiredRole":"guest","source":"server/index.js"},
    {"id":"api:/claude-remote/docs","area":"other","kind":"api","priority":"P2","requiredRole":"guest","source":"server/index.js"},
    {"id":"api:*","area":"other","kind":"api","priority":"P1","requiredRole":"user","source":"server/index.js"},
    {"id":"api:/api/auth/google/url","area":"auth","kind":"api","priority":"P0","requiredRole":"guest","source":"server/routes/authRoutes.js"},
    {"id":"api:/api/auth/google/callback","area":"auth","kind":"api","priority":"P0","requiredRole":"guest","source":"server/routes/authRoutes.js"},
    {"id":"api:/api/auth/verify","area":"auth","kind":"api","priority":"P0","requiredRole":"guest","source":"server/routes/authRoutes.js"},
    {"id":"api:/api/auth/logout","area":"auth","kind":"api","priority":"P0","requiredRole":"guest","source":"server/routes/authRoutes.js"},
    {"id":"api:/api/auth/protected","area":"auth","kind":"api","priority":"P0","requiredRole":"guest","source":"server/routes/authRoutes.js"},
    {"id":"api:/api/chat/models","area":"chat","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/commands","area":"chat","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/skills","area":"chat","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/mcp-tools","area":"chat","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/servers","area":"chat","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/sessions","area":"chat","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/sessions/deep-clean","area":"chat","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/projects","area":"chat","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/projects/config","area":"chat","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/projects/:slug/open","area":"chat","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/projects/:slug","area":"chat","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/sessions/:id","area":"chat","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/sessions/:id/history","area":"chat","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/sessions/:id/context","area":"chat","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/sessions/:id/compact","area":"chat","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/sessions/:id/message","area":"chat","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/sessions/:id/blobs","area":"chat","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/sessions/:id/stream","area":"chat","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/sessions/:id/stop","area":"chat","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/sessions/:id/health","area":"chat","kind":"api","priority":"P2","requiredRole":"guest","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/push/key","area":"chat","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/push/subscribe","area":"chat","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/push/unsubscribe","area":"chat","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/rate-limit","area":"chat","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/chat/token-stats","area":"chat","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/chatRoutes.js"},
    {"id":"api:/api/futures/kline/daily","area":"futures","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/futuresRoutes.js"},
    {"id":"api:/api/futures/kline/hourly","area":"futures","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/futuresRoutes.js"},
    {"id":"api:/api/futures/kline/15min","area":"futures","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/futuresRoutes.js"},
    {"id":"api:/api/futures/chat/session","area":"futures","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/futuresRoutes.js"},
    {"id":"api:/api/futures/chat/message","area":"futures","kind":"api","priority":"P0","requiredRole":"user","source":"server/routes/futuresRoutes.js"},
    {"id":"api:/api/futures/chat/history","area":"futures","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/futuresRoutes.js"},
    {"id":"api:/api/host-protection/events","area":"host-protection","kind":"api","priority":"P1","requiredRole":"admin","source":"server/routes/hostProtectionRoutes.js"},
    {"id":"api:/api/host-protection/status","area":"host-protection","kind":"api","priority":"P2","requiredRole":"admin","source":"server/routes/hostProtectionRoutes.js"},
    {"id":"api:/api/usage","area":"usage","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/usageRoutes.js"},
    {"id":"api:/api/usage/history","area":"usage","kind":"api","priority":"P1","requiredRole":"user","source":"server/routes/usageRoutes.js"},
    {"id":"page:/chat-page","area":"client","kind":"page","priority":"P1","requiredRole":"user","testId":"app-page-chat-page","source":"client/src/pages/ChatPage.jsx"},
    {"id":"page:/claude-remote-monitor","area":"client","kind":"page","priority":"P1","requiredRole":"user","testId":"app-page-claude-remote-monitor","source":"client/src/pages/ClaudeRemoteMonitor.jsx"},
    {"id":"page:/cpu-monitor","area":"client","kind":"page","priority":"P1","requiredRole":"user","testId":"app-page-cpu-monitor","source":"client/src/pages/CpuMonitor.jsx"},
    {"id":"page:/host-protection","area":"client","kind":"page","priority":"P1","requiredRole":"admin","testId":"app-page-host-protection","source":"client/src/pages/HostProtection.jsx"},
    {"id":"page:/login-page","area":"client","kind":"page","priority":"P0","requiredRole":"guest","testId":"app-page-login-page","source":"client/src/pages/LoginPage.jsx","probes":[{"expectVisible":"app-page-login-page"},{"__todo":"no intent given — `ubi intent <id> \"…\"` and re-run adopt to derive real probes"}]},
    {"id":"page:/recovery-logs","area":"client","kind":"page","priority":"P2","requiredRole":"user","testId":"app-page-recovery-logs","source":"client/src/pages/RecoveryLogs.jsx"},
    {"id":"page:/usage-page","area":"client","kind":"page","priority":"P1","requiredRole":"user","testId":"app-page-usage-page","source":"client/src/pages/UsagePage.jsx"}
  ],
  ignored: [],
  publicApi: [],
  exposure: [],
  /**
   * ACCEPTED DEBT — a human decision, recorded.
   *
   * The private key in k8s/configmap-ssh-keys.yaml is REAL and it is also in
   * git history, so deleting the file does not un-leak it. The only fix is
   * rotation, which is an operational task with a date on it — not something
   * a deploy gate should block every single ship over in the meantime.
   *
   * `baselineAdmission` allows this ONLY because it is judged real and carries
   * a written reason. A finding judged a false positive, or judged correct
   * behaviour, is refused outright — those must be fixed in the rule.
   *
   * This entry is dated on purpose: `debtAge` reports how long it has stood,
   * so it cannot quietly become permanent.
   */
  baseline: [
    {
      fingerprint: "b5d658d33b13439db54ce90c9a3f41db",
      rule: "S0.secret.tree",
      severity: "critical",
      verdict: "real",
      reason: "ssh key committed 2026-03; rotation scheduled. Deleting the file does not help — it is in history.",
      acceptedAt: Date.parse("2026-09-14"),
    },
    {
      fingerprint: "973eec70e41d573f3ff9d5b3c67b75b0",
      rule: "S0.secret.history",
      severity: "critical",
      verdict: "real",
      reason: "ssh key committed 2026-03; rotation scheduled. Deleting the file does not help — it is in history.",
      acceptedAt: Date.parse("2026-09-14"),
    },
  ],
}
