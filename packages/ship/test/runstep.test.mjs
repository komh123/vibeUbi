/**
 * The claim is "the kill reaches the tree". A fix that silently no-ops is worse
 * than no fix, because it reports success — so this test spawns a real
 * grandchild and asserts it is actually dead afterwards.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ship, machineMemory } from "../src/run.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

test("machineMemory reports MB, and never an unlimited cgroup as a huge fence", async () => {
  const m = await machineMemory()
  assert.ok(m.availableMb > 0 && m.availableMb < 2 ** 31)
  assert.ok(m.cgroupLimitMb === null || (m.cgroupLimitMb > 0 && m.cgroupLimitMb < 2 ** 31),
    `an unlimited cgroup must read as no fence, not as ${m.cgroupLimitMb} MB`)
})

test("a timed-out step takes its whole process tree with it", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-kill-"))
  try {
    // The step spawns a grandchild that outlives it, writes its pid, and sleeps.
    await writeFile(join(root, "step.mjs"), `
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
const g = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"], { stdio: "ignore" })
writeFileSync(process.argv[2], String(g.pid))
setInterval(() => {}, 1e9)
`, "utf8")
    const pidFile = join(root, "grandchild.pid")

    let done = null
    const run = ship({
      root, discovered: [],
      config: {
        base: "http://127.0.0.1:1",
        verify: [{ name: "hangs", cmd: `${process.execPath} ${join(root, "step.mjs")} ${pidFile}` }],
        budgets: { verify: 1500 },
      },
      target: { proofClaim: { external: true, carriesArtifactId: true, source: "test" }, async proof() { return {} } },
      emit: (e) => { if (e.kind === "done") done = e },
    })

    // wait for the grandchild to exist
    let gpid = null
    for (let i = 0; i < 60 && !gpid; i++) { await sleep(100); gpid = Number(await readFile(pidFile, "utf8").catch(() => "")) || null }
    assert.ok(gpid, "the fixture never started a grandchild — this test would pass vacuously")
    assert.ok(alive(gpid), "grandchild should be running before the timeout")

    await run
    await sleep(600)
    assert.equal(alive(gpid), false,
      `grandchild ${gpid} survived the step's timeout — execFile's killSignal only reaches the direct child, which is the bug this replaces`)
    assert.match(done?.reason ?? "", /timed out/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
