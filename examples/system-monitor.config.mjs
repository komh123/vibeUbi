/**
 * VibeShip config for the system-monitor project.
 *
 * Kept OUTSIDE that repository on purpose: `vibeship scan --config <this>`
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
    "vibeship-express": {
      root: ROOT,
      entry: "server/index.js",
      routesDir: "server/routes",
      pagesDir: "client/src/pages",
      // versionPath: "/api/version",   ← not wired yet; see the scan output
    },
  },

  roles: ["guest", "user"],

  /** Auth helpers THIS project uses. Nothing can guess these, and guessing is
   *  how a scanner ends up at 20% precision. */
  gateTokens: ["requireAuth", "authenticate", "verifyToken", "jwt.verify", "req.user", "authMiddleware"],

  declared: [],
  ignored: [],
  publicApi: [],
  exposure: [],
  baseline: [],
}
