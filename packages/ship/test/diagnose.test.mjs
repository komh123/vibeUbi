import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diagnose } from "../src/diagnose.mjs"
import { countsAsEvidence } from "../../kernel/src/index.mjs"

const node = process.execPath

test("diagnose runs every step past a red and reports all failures, outside the gate's runs directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-diag-"))
  try {
    const config = { verify: [
      { name: "first-red", cmd: `${node} -e process.exit(3)` },
      { name: "green", cmd: `${node} -e 0` },
      { name: "proves-nothing", cmd: `${node} -e 0`, expectsTests: true },
      { name: "second-red", cmd: `${node} -e process.exit(1)` },
    ] }
    const seen = []
    const report = await diagnose({ root, config, emit: (e) => e.kind === "step" && e.state !== "run" && seen.push(e.name) })

    assert.deepEqual(seen, ["first-red", "green", "proves-nothing", "second-red"], "a red must not stop the run")
    assert.deepEqual(report.failed.map((f) => f.name), ["first-red", "proves-nothing", "second-red"])
    assert.equal(report.failed[0].why, "exited 3")
    assert.equal(report.passed, 1)
    assert.equal(report.kind, "diagnostic")

    assert.equal(existsSync(join(root, ".vibeubi", "runs")), false, "a gate must not be able to find it")
    const dirs = await readdir(join(root, ".vibeubi", "diagnostics"))
    assert.equal(dirs.length, 1)
    const onDisk = JSON.parse(await readFile(join(root, ".vibeubi", "diagnostics", dirs[0], "report.json"), "utf8"))
    assert.equal(countsAsEvidence(onDisk).ok, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a fully green diagnostic is still not evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-diag-"))
  try {
    const report = await diagnose({ root, config: { verify: [{ name: "a", cmd: `${node} -e 0` }] } })
    assert.equal(report.clean, true)
    assert.equal(countsAsEvidence({ ...report, ok: true, phase: "verify" }, { phase: "verify" }).ok, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("--only narrows and is marked; an unknown name is refused before anything runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-diag-"))
  try {
    const config = { verify: [{ name: "a", cmd: `${node} -e 0` }, { name: "b", cmd: `${node} -e 0` }] }
    const r = await diagnose({ root, config, only: ["b"] })
    assert.deepEqual(r.results.map((x) => x.name), ["b"])
    assert.equal(r.narrowed, true)
    await assert.rejects(diagnose({ root, config, only: ["nope"] }), /unknown step/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
