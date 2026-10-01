/**
 * A VibeUbi config, annotated.
 *
 * Copy it, fill it in, and keep it in YOUR project — not here. This repository
 * holds the architecture and the flow; what any particular codebase declares
 * about itself belongs with that codebase, because it is a statement about that
 * codebase and nobody else can check it.
 *
 * Every value below is a placeholder. Nothing here describes a real system.
 */
import * as express from "../packages/adapters/src/express.plugin.mjs"

export default {
  name: "example",
  plugins: [express],

  pluginConfig: {
    "vibeubi-express": {
      root: "/path/to/your/project",
      entry: "server/index.js",
      routesDir: "server/routes",
      pagesDir: "client/src/pages",

      /**
       * THE ONE FIELD NOTHING ELSE WILL CATCH.
       *
       * An endpoint on the RUNNING service that echoes the id stamped INTO the
       * artifact — not the git commit, which describes the source rather than
       * what is deployed. A wrong answer here produces no error anywhere else;
       * the gate simply issues green for ever.
       *
       * `proofContract` refuses a proof that cannot carry an id, and
       * `proofDiscrimination` goes further: across deploys the value must
       * CHANGE when the artifact changes, and RETURN when a rollback brings an
       * artifact back. A field that only does the first is a timestamp.
       */
      versionPath: "/api/version",

      buildCommand: "npm run build",
      startCommand: "node server/index.js",
      distDir: "dist",
      env: { PORT: "3000", NODE_ENV: "production" },
      startWaitMs: 2500,
    },
  },

  base: "http://127.0.0.1:3000",
  roles: ["guest", "user", "admin"],

  /**
   * The auth helpers YOUR code calls. Nothing can guess these, and guessing is
   * how a scanner reaches 20% precision — until this is filled in, every route
   * reads as ungated and the first report is a wall of red nobody trusts.
   */
  gateTokens: ["requireAuth", "verifyToken", "req.user"],

  /** Offline checks that must pass before anything is built. `expectsTests`
   *  makes the step prove it RAN tests — exit 0 with zero tests is not a pass. */
  verify: [
    { name: "unit", cmd: "npm test", expectsTests: true },
  ],

  layers: ["S0", "S2", "S4"],

  /**
   * The registry. `vibeubi adopt` drafts this; you correct two fields, because
   * those are the two the gate reads:
   *
   *   priority      P0 blocks a deploy, P1 and P2 are reported
   *   requiredRole  `guest` is you signing that the route is deliberately public
   */
  declared: [
    // { id: "api:/api/thing", area: "thing", kind: "api", priority: "P0",
    //   requiredRole: "user", source: "server/routes/thing.js" },
    // { id: "page:/login", area: "auth", kind: "page", priority: "P0",
    //   requiredRole: "guest", testId: "app-page-login" },
  ],

  /** Not features. Every entry needs a reason a reviewer would accept. */
  ignored: [],

  /** Deliberately unauthenticated. `requiredRole: "guest"` says WHAT; an entry
   *  here says WHY, and the why is the half that survives the person leaving. */
  publicApi: [
    // { id: "api:/health", reason: "no data; used by the load balancer" },
  ],

  /** Listeners that are supposed to exist. Anything listening that is NOT here
   *  is an orphan — the network version of an undeclared feature. */
  exposure: [],

  /**
   * Accepted debt. Each entry is a SIGNED STATEMENT that the finding is real
   * and the team took it on — so `baselineAdmission` refuses anything judged a
   * false positive or correct behaviour, because writing a reporting bug in
   * here turns it into a standing lie. `debtAge` reports how long each has
   * stood, so none of them can quietly become permanent.
   */
  baseline: [],

  /** The skill step, after the gate. See docs/SKILL-STEP.md. */
  probe: {
    skill: "dom-test",
    only: ["P0"],
  },

  /**
   * Functional behaviour, judged AFTER the swap — optional, off until declared.
   * See docs/PORTING.md §3b. Commented out because `fulfil` is yours to write.
   *
   * Why it is not a pre-swap stage: before the swap `base` is still the
   * PREVIOUS build, so a pre-swap functional pass judges the build you are
   * replacing. The only pre-swap form is `phase: "pre-swap-health"` (liveness,
   * `healthOnly: true`, a `timeBudgetMs`), which refuses and never rolls back.
   *
   * acceptance: {
   *   phase: "post-swap",
   *   items: [
   *     { id: "acc:<your-core-flow>", severity: "P0", attempts: 2 },  // red → roll back, proved
   *     { id: "acc:<a-nice-to-have>", severity: "P1" },               // red → warned, ships
   *   ],
   *   async fulfil(order, { signal }) {
   *     // run your scenarios against order.base, then return
   *     // { skill: order.skill, artifactId: order.artifactId, observed: [{ id, verdict: "PASS" | "FAIL", why }] }
   *   },
   * },
   */
}
