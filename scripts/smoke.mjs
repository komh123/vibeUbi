/**
 * smoke.mjs — prove the CLI works against a real throwaway project.
 *
 * Unit tests prove the kernel decides correctly. This proves the wiring
 * actually reaches it: a plugin loads, a discoverer walks a real tree, an
 * orphan is found, a rug pull is caught. Those are different claims, and this
 * repo's own thesis says you do not get to assume the second from the first.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
const run = promisify(execFile)
const HERE = join(fileURLToPath(import.meta.url), "..", "..")

const checks = []
const check = (name, fn) => checks.push([name, fn])

const dir = await mkdtemp(join(tmpdir(), "vibeubi-smoke-"))
await mkdir(join(dir, "app", "secret"), { recursive: true })
await writeFile(join(dir, "app", "page.tsx"), "export default function P(){return null}")
await writeFile(join(dir, "app", "secret", "page.tsx"), "export default function P(){return null}")
await writeFile(join(dir, "vibeubi.config.mjs"), `
import * as nextjs from ${JSON.stringify(join(HERE, "packages/adapters/src/nextjs.plugin.mjs"))}
export default {
  name: "smoke", plugins: [nextjs],
  pluginConfig: { "vibeubi-nextjs": { root: ${JSON.stringify(dir)} } },
  declared: [{ id: "page:/", area: "home", priority: "P1" }],
  tools: [{ server: "s", name: "t", description: "clean", inputSchema: {} }],
  toolPins: [{ key: "s/t", fingerprint: "STALE" }],
  declaredTools: ["s/t"],
}
`)

const cli = (...args) => run("node", [join(HERE, "bin/vibeubi.mjs"), ...args, "--root", dir])
  .then((r) => ({ code: 0, ...r }))
  .catch((e) => ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }))

check("plan touches nothing and reports the proof contract", async () => {
  const r = await cli("plan")
  if (r.code !== 0) throw new Error(`exit ${r.code}`)
  if (!r.stdout.includes("BUILD_ID")) throw new Error("proof source not reported")
})

check("an undeclared page is found as an orphan and exits non-zero", async () => {
  const r = await cli("orphans")
  if (r.code === 0) throw new Error("an orphan must fail the command")
  if (!r.stdout.includes("page:/secret")) throw new Error("the orphan was not named")
})

check("a stale pin is reported as a rug pull", async () => {
  const r = await cli("roster")
  if (!r.stdout.includes("rug_pull")) throw new Error("drift not caught")
})

check("viz emits parseable IR with provenance", async () => {
  const r = await cli("viz", "--format", "ir")
  const ir = JSON.parse(r.stdout)
  const node = ir.groups.flatMap((g) => g.nodes).find((n) => n.id === "page:/secret")
  if (!node?.provenance?.discoveredIn) throw new Error("a node with no provenance is an illustration, not evidence")
})

check("guard refuses a narrowing action", async () => {
  const r = await cli("guard", "--action", "accept-debt")
  if (r.code === 0) throw new Error("accept-debt must require a human")
})

let failed = 0
for (const [name, fn] of checks) {
  try { await fn(); console.log(`ok   ${name}`) }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`) }
}
await rm(dir, { recursive: true, force: true })
console.log(`\n# smoke ${checks.length - failed}/${checks.length} passed`)
process.exit(failed ? 1 : 0)
