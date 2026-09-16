/**
 * `build` was the only spawning step in the pipeline with no heap ceiling, no
 * clock and no tree kill — while `verify`, the cheaper step, had all three.
 * These tests assert the BEHAVIOUR (what the child actually received, what
 * actually died), not the position of a call site, because a call site in the
 * right place that passes the wrong thing looks identical from the outside.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "../src/process-target.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

test("the build command actually receives the heap ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-build-"))
  try {
    const seen = join(root, "node-options.txt")
    await writeFile(join(root, "b.mjs"), `
import { writeFileSync, mkdirSync } from "node:fs"
writeFileSync(${JSON.stringify(seen)}, process.env.NODE_OPTIONS ?? "")
mkdirSync(process.env.VIBEUBI_OUT, { recursive: true })
`, "utf8")
    await build({ root, cmd: `${process.execPath} ${join(root, "b.mjs")}`, heapMb: 4321 })
    const opts = await readFile(seen, "utf8")
    assert.match(opts, /--max-old-space-size=4321/,
      "the build spawned without a ceiling — the step most likely to exhaust a heap was the one without a guard")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("an existing NODE_OPTIONS is appended to, never replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-build-env-"))
  const prev = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = "--enable-source-maps"
  try {
    const seen = join(root, "opts.txt")
    await writeFile(join(root, "b.mjs"), `
import { writeFileSync, mkdirSync } from "node:fs"
writeFileSync(${JSON.stringify(seen)}, process.env.NODE_OPTIONS ?? "")
mkdirSync(process.env.VIBEUBI_OUT, { recursive: true })
`, "utf8")
    await build({ root, cmd: `${process.execPath} ${join(root, "b.mjs")}`, heapMb: 2048 })
    const opts = await readFile(seen, "utf8")
    assert.match(opts, /--enable-source-maps/, "clobbering the project's own NODE_OPTIONS is a silent behaviour change")
    assert.match(opts, /--max-old-space-size=2048/)
  } finally {
    if (prev === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prev
    await rm(root, { recursive: true, force: true })
  }
})

test("a build that hangs is killed WITH its workers, and says so", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-build-hang-"))
  try {
    const pidFile = join(root, "worker.pid")
    await writeFile(join(root, "b.mjs"), `
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
const w = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], { stdio: "ignore" })
writeFileSync(${JSON.stringify(pidFile)}, String(w.pid))
setInterval(() => {}, 1e9)
`, "utf8")
    const p = build({ root, cmd: `${process.execPath} ${join(root, "b.mjs")}`, timeoutMs: 1200 })
    let wpid = null
    for (let i = 0; i < 60 && !wpid; i++) { await sleep(100); wpid = Number(await readFile(pidFile, "utf8").catch(() => "")) || null }
    assert.ok(wpid, "the fixture never started a worker — this test would pass vacuously")
    await assert.rejects(() => p, /passed its 1s budget/)
    await sleep(500)
    assert.equal(alive(wpid), false,
      `worker ${wpid} outlived the build — execFile's killSignal reaches only the child we hold, and a bundler's workers are not that child`)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a failing build restores the live artifact and reports the exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-build-fail-"))
  try {
    await mkdir(join(root, "dist"), { recursive: true })
    await writeFile(join(root, "dist/BUILD_ID"), "the-one-serving", "utf8")
    await writeFile(join(root, "b.mjs"), `process.exit(3)\n`, "utf8")
    await assert.rejects(() => build({ root, cmd: `${process.execPath} ${join(root, "b.mjs")}` }), /exited 3/)
    assert.equal((await readFile(join(root, "dist/BUILD_ID"), "utf8")).trim(), "the-one-serving",
      "a failed build must not leave the live artifact in whatever half-state the tool stopped at")
  } finally { await rm(root, { recursive: true, force: true }) }
})
