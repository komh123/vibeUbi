/**
 * The claim is "no outage". A test that does not MEASURE is not testing that
 * claim, so this file runs a real proxy, real slot processes, a real flip and
 * a real rollback, with a poller on the public port throughout.
 */
import { test, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { blueGreenTarget, nextSlot, other, layout } from "../src/blue-green.mjs"

test("nextSlot alternates, and starts somewhere on a first deploy", () => {
  assert.equal(nextSlot(null), "blue")
  assert.equal(nextSlot({}), "blue")
  assert.equal(nextSlot({ live: "nonsense" }), "blue", "a corrupt pointer must not pick a slot at random")
  assert.equal(nextSlot({ live: "blue" }), "green")
  assert.equal(nextSlot({ live: "green" }), "blue")
  assert.equal(other("blue"), "green")
})

test("layout keeps both slots on disk at once — that is what makes rollback free", () => {
  const l = layout({ root: "/r" })
  assert.equal(l.slot("blue").dist, "/r/dist-blue")
  assert.equal(l.slot("green").dist, "/r/dist-green")
  assert.notEqual(l.slot("blue").port, l.slot("green").port)
})

test("a deploy and a rollback, both measured, drop zero requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-bg-"))
  const publicPort = 4390, ports = { blue: 4391, green: 4392 }

  // A slot: reads its build id off disk and echoes it, like a real app's /version.
  await writeFile(join(root, "app.mjs"), `
import http from "node:http"
import { readFileSync } from "node:fs"
const id = readFileSync(process.env.VIBEUBI_DIST + "/BUILD_ID", "utf8").trim()
http.createServer((q, s) => { s.writeHead(200, {"content-type":"text/plain"}); s.end(id) })
  .listen(Number(process.env.PORT), "127.0.0.1")
`, "utf8")

  let n = 0
  const target = blueGreenTarget({
    root, publicPort, ports, versionPath: "/version",
    startCmd: `${process.execPath} ${join(root, "app.mjs")}`,
    buildCmd: `${process.execPath} -e const_fs=require('fs');const_fs.mkdirSync(process.env.VIBEUBI_OUT,{recursive:true});const_fs.writeFileSync(process.env.VIBEUBI_OUT+'/BUILD_ID','build-'+process.env.N)`,
    readArtifactId: async (dist) => (await import("node:fs")).readFileSync(join(dist, "BUILD_ID"), "utf8").trim(),
    drainMs: 300,
  })
  after(async () => { await target.stopAll(); await rm(root, { recursive: true, force: true }) })

  // The buildCmd above can't take env per call, so stage the builds by hand —
  // the adapter's job under test is the flip, not the bundler.
  const stage = async (id) => {
    const s = await target.build()
    await mkdir(s.dist, { recursive: true })
    await writeFile(join(s.dist, "BUILD_ID"), id, "utf8")
    return await target.artifactId()
  }

  const first = await stage("build-1")
  assert.equal(first, "build-1")
  await target.swap()

  const hit = () => new Promise((r) => {
    const req = http.get({ host: "127.0.0.1", port: publicPort, path: "/version" }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => r(res.statusCode === 200 ? b.trim() : `HTTP ${res.statusCode}`))
    })
    req.on("error", (e) => r(`ERR ${e.code}`)); req.setTimeout(500, () => { req.destroy(); r("TIMEOUT") })
  })

  const seen = []
  let stop = false
  const poll = (async () => { while (!stop) { seen.push(await hit()); await new Promise((r) => setTimeout(r, 8)) } })()

  await new Promise((r) => setTimeout(r, 250))
  await stage("build-2")
  await target.swap()                       // the deploy
  await new Promise((r) => setTimeout(r, 250))
  const afterDeploy = await hit()
  await target.rollback()                   // the undo
  await new Promise((r) => setTimeout(r, 250))
  const afterRollback = await hit()
  stop = true; await poll

  const bad = seen.filter((s) => s !== "build-1" && s !== "build-2")
  assert.equal(afterDeploy, "build-2", "the deploy did not take")
  assert.equal(afterRollback, "build-1", "the rollback did not take")
  assert.ok(seen.length > 60, `only ${seen.length} samples — the poller was not running`)
  assert.deepEqual(bad, [], `dropped ${bad.length}/${seen.length} requests: ${[...new Set(bad)].join(", ")}`)
  assert.ok(seen.includes("build-1") && seen.includes("build-2"), "the poller never saw both builds — it was not sampling across the flip")
})

test("a build that never boots does not flip the pointer, so no user sees it", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-bg-dead-"))
  const publicPort = 4393, ports = { blue: 4394, green: 4395 }
  await writeFile(join(root, "app.mjs"), `
import http from "node:http"
import { readFileSync } from "node:fs"
const id = readFileSync(process.env.VIBEUBI_DIST + "/BUILD_ID", "utf8").trim()
if (id === "broken") process.exit(1)
http.createServer((q,s)=>{s.writeHead(200);s.end(id)}).listen(Number(process.env.PORT),"127.0.0.1")
`, "utf8")
  const target = blueGreenTarget({
    root, publicPort, ports, versionPath: "/version",
    startCmd: `${process.execPath} ${join(root, "app.mjs")}`,
    readArtifactId: async (dist) => (await import("node:fs")).readFileSync(join(dist, "BUILD_ID"), "utf8").trim(),
    drainMs: 100,
  })
  try {
    const stage = async (id) => { const s = await target.build(); await mkdir(s.dist, { recursive: true }); await writeFile(join(s.dist, "BUILD_ID"), id, "utf8"); return target.artifactId() }
    await stage("good-1"); await target.swap()
    await stage("broken")
    await assert.rejects(() => target.swap(), /never served broken .* pointer was NOT flipped/s)
    const observed = await target.proof({ expected: "broken", previous: "good-1" })
    assert.ok(observed.observed.includes("good-1"), `traffic moved to a build that never booted: ${observed.observed}`)
  } finally { await target.stopAll(); await rm(root, { recursive: true, force: true }) }
})
