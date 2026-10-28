import test from "node:test"
import assert from "node:assert/strict"
import { inputClass, splitInputs, globMatches, ALWAYS_BUILD_INPUTS, countsAsEvidence } from "../src/index.mjs"

const cfg = { testInputs: ["SHIPS.md", "scripts/acceptance/**", "**/*.test.js", "docs/**"] }

test("with no testInputs configured every file is a build input (today's behaviour)", () => {
  for (const f of ["a.js", "docs/x.md", "scripts/acceptance/a.mjs", "SHIPS.md"]) assert.equal(inputClass(f, {}), "build")
  assert.equal(inputClass("docs/x.md"), "build")
})

test("a file matched by a testInputs glob is a test input; a file in no list is a build input", () => {
  assert.equal(inputClass("SHIPS.md", cfg), "test")
  assert.equal(inputClass("scripts/acceptance/web.mjs", cfg), "test")
  assert.equal(inputClass("web/a.test.js", cfg), "test")
  assert.equal(inputClass("web/a.js", cfg), "build")
  assert.equal(inputClass("brand-new-root/data.json", cfg), "build", "unlisted must rebuild, never reuse")
})

test("lockfiles, Dockerfiles, framework/env config are build inputs even when a testInputs glob matches them", () => {
  const everything = { testInputs: ["**"] }
  for (const f of ["package-lock.json", "web/package.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
    "Dockerfile", "docker/Dockerfile.web", "next.config.mjs", "web/vite.config.ts", "tsconfig.json", "web/tsconfig.build.json",
    ".env.example", "web/.env.template", ".env", "scripts/acceptance/package-lock.json"]) {
    assert.equal(inputClass(f, everything), "build", f)
  }
  assert.equal(inputClass("notes.md", everything), "test")
  assert.ok(ALWAYS_BUILD_INPUTS.length > 5)
})

test("a project can add always-build globs of its own (buildInputs) and they win over testInputs", () => {
  assert.equal(inputClass("docs/schema.sql", { testInputs: ["docs/**"], buildInputs: ["**/*.sql"] }), "build")
})

test("splitInputs partitions without losing or duplicating a file", () => {
  const files = ["web/a.js", "SHIPS.md", "docs/x.md", "package-lock.json", "z.txt"]
  const { build, test: t } = splitInputs(files, cfg)
  assert.deepEqual(build, ["web/a.js", "package-lock.json", "z.txt"])
  assert.deepEqual(t, ["SHIPS.md", "docs/x.md"])
  assert.equal(build.length + t.length, files.length)
})

test("globMatches keeps the negation / ** semantics delivery relied on", () => {
  assert.equal(globMatches("a/b/c.js", ["**"]), true)
  assert.equal(globMatches("docs/a.md", ["**", "!docs/**"]), false)
  assert.equal(globMatches("a.js", ["*.js"]), true)
  assert.equal(globMatches("x/a.js", ["*.js"]), false)
})

test("countsAsEvidence: a build-phase report needs the same build inputs only; anything else needs both hashes", () => {
  const r = { ok: true, phase: "build", buildInputsHash: "b1", testInputsHash: "t1" }
  assert.deepEqual(countsAsEvidence(r, { phase: "build", buildInputsHash: "b1", testInputsHash: "t2" }), { ok: true })
  assert.match(countsAsEvidence(r, { phase: "build", buildInputsHash: "b2" }).reason, /build inputs/)
  const a = { ok: true, phase: "acceptance", buildInputsHash: "b1", testInputsHash: "t1" }
  assert.deepEqual(countsAsEvidence(a, { phase: "acceptance", buildInputsHash: "b1", testInputsHash: "t1" }), { ok: true })
  assert.match(countsAsEvidence(a, { phase: "acceptance", buildInputsHash: "b1", testInputsHash: "t2" }).reason, /test inputs/)
  assert.match(countsAsEvidence(a, { phase: "acceptance", buildInputsHash: "b2", testInputsHash: "t1" }).reason, /build inputs/)
  assert.match(countsAsEvidence(a, { phase: "acceptance", buildInputsHash: "b1" }).reason, /both/, "acceptance evidence must be asked for with both hashes")
  assert.match(countsAsEvidence({ ok: true, phase: "build" }, { phase: "build", buildInputsHash: "b1" }).reason, /build inputs/, "a report with no hash cannot match")
})
