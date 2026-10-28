/**
 * inputs.mjs — which files can change a build product, and which can only change a test.
 *
 * ## Why this exists
 *
 * Evidence bound to ONE whole-tree hash is invalidated by any edit, including an
 * edit to an acceptance script or a release ledger. One consumer paid a ~45 minute
 * rebuild of its web app, images and daemons for a change that could not alter any
 * of them. Build systems (Turborepo, Bazel) answer this with one idea: a step
 * declares its inputs and its cache key is the hash of exactly those inputs.
 *
 * Here the tree is split in two:
 *
 *   · buildInputs — source and config that can change a build product
 *   · testInputs  — acceptance scripts, test files, fixtures, docs, generated ledgers
 *
 * A build-type step keys on buildInputs only. An acceptance step keys on both.
 * When only testInputs changed, a build step may be REUSED — but only against a
 * pinned artifact identity (see ship/delivery.mjs), never "a rebuild that should
 * be identical".
 *
 * ## The fail-safe (the part that must not be argued with)
 *
 * Classification is by explicit `testInputs` globs from the project's config, and
 * the default is that there are none: every file is a buildInput, which is the
 * behaviour before this existed. On top of that:
 *
 *   1. a file in NO list is a buildInput — an unknown file rebuilds, never reuses;
 *   2. lockfiles, Dockerfiles, framework config and env templates are buildInputs
 *      even when a testInputs glob (say `**`) would also match them, because a
 *      wrong guess there ships a stale artifact under a green light.
 *
 * Zero I/O: a list of paths in, a classification out. Hashing stays in ship.
 */

/** Glob match with `**`, `*`, `?` and `!negation`. Moved here verbatim from delivery. */
export function globMatches(file, patterns = []) {
  const positive = patterns.filter((p) => !p.startsWith("!"))
  const negative = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1))
  if (negative.length && globMatches(file, negative)) return false
  return positive.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0\//g, "(?:.*/)?").replace(/\0/g, ".*")
    return new RegExp(`^${escaped}$`).test(file)
  })
}

/**
 * Files that can change a build product no matter what a testInputs glob says.
 * Anywhere in the tree (`**\/` prefix also matches the root).
 */
export const ALWAYS_BUILD_INPUTS = Object.freeze([
  // dependency pins
  "**/package.json", "**/package-lock.json", "**/npm-shrinkwrap.json", "**/yarn.lock", "**/pnpm-lock.yaml",
  "**/bun.lock", "**/bun.lockb", "**/Cargo.lock", "**/Cargo.toml", "**/poetry.lock", "**/Pipfile.lock",
  "**/requirements*.txt", "**/go.mod", "**/go.sum", "**/Gemfile.lock",
  // container recipes
  "**/Dockerfile", "**/Dockerfile.*", "**/*.dockerfile", "**/.dockerignore", "**/docker-compose*.yml", "**/docker-compose*.yaml",
  // framework / compiler config
  "**/*.config.*", "**/tsconfig*.json", "**/jsconfig*.json", "**/.babelrc", "**/.babelrc.*", "**/.npmrc", "**/.nvmrc", "**/.node-version",
  // environment
  "**/.env", "**/.env.*", "**/*.env", "**/*.env.example", "**/*.env.template",
])

/**
 * @typedef {{ testInputs?: readonly string[], buildInputs?: readonly string[] }} InputRules
 *   `buildInputs` are a project's extra always-build globs; they win over `testInputs`.
 */

/**
 * @param {string} file  repo-relative, forward slashes
 * @param {InputRules} [rules]
 * @returns {"build" | "test"}
 */
export function inputClass(file, rules = {}) {
  const tests = rules?.testInputs ?? []
  if (!tests.length) return "build"
  if (globMatches(file, [...ALWAYS_BUILD_INPUTS, ...(rules.buildInputs ?? [])])) return "build"
  return globMatches(file, tests) ? "test" : "build"
}

/**
 * Partition a file list. Nothing is lost and nothing is counted twice.
 *
 * @param {readonly string[]} files
 * @param {InputRules} [rules]
 * @returns {{ build: string[], test: string[] }}
 */
export function splitInputs(files, rules = {}) {
  const build = [], test = []
  for (const f of files) (inputClass(f, rules) === "test" ? test : build).push(f)
  return { build, test }
}
