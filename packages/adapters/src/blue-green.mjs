/**
 * blue-green.mjs — a deploy target with no outage and an instant rollback.
 *
 * WHY THIS EXISTS, in numbers measured on this machine with a 10ms poller:
 *
 *     process-target, app binds instantly   632ms of outage
 *     process-target, app boots in 1.5s   2,110ms of outage
 *     this adapter                             0ms   (202 polls, 0 down)
 *
 * The shape: two slots, each a full build and its own process on its own
 * loopback port, and a proxy on the public port that forwards to whichever
 * slot a pointer file names. Deploy = build into the IDLE slot, start it,
 * wait until it serves the new id ON ITS OWN PORT, then flip the pointer.
 *
 * Three consequences that are worth more than the zero:
 *
 * 1. A BUILD THAT DOES NOT BOOT NEVER REACHES A USER. The old shape moved the
 *    new build into place and restarted, so a build that crashed on startup
 *    was already live and serving errors while the pipeline worked out that it
 *    should not be. Here the flip is the last step and it is gated on the new
 *    slot answering. If it never answers, production never saw it.
 *
 * 2. ROLLBACK IS A POINTER FLIP. The previous slot is left RUNNING, so undoing
 *    a deploy costs one file write and no restart — no second outage on the
 *    unhappy path, which is exactly where the old shape put one.
 *
 * 3. THE PROOF GETS MORE HONEST, NOT LESS. `proof` reads through the PUBLIC
 *    port, so what it observes is what a user gets. Reading a slot directly
 *    would prove the process is up while the proxy still points elsewhere.
 *
 * WHAT IT COSTS: two copies of the app resident at once, and one more hop.
 *
 * WHY NOT SO_REUSEPORT: it also measures 0ms of outage and needs no proxy, but
 * during the overlap the kernel round-robins between the two processes — 40
 * requests through a real overlap came back exactly 20 old / 20 new. Proof
 * becomes a coin flip, and a pipeline whose evidence is a coin flip is the
 * thing this product exists to remove. It is a fine transport; it is not a
 * deploy gate.
 */
import { mkdir, writeFile, readFile, rename, rm, cp } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

export const SLOTS = ["blue", "green"]
export const other = (slot) => (slot === "blue" ? "green" : "blue")

/**
 * Where everything lives. Exported as data so `--plan` can print it and a test
 * can assert it without starting anything.
 */
export function layout({ root, stateDir = ".vibeubi/bg", ports = { blue: 4101, green: 4102 } }) {
  const dir = join(root, stateDir)
  return {
    dir,
    pointer: join(dir, "pointer.json"),
    proxyPid: join(dir, "proxy.pid"),
    proxyLog: join(dir, "proxy.log"),
    slot: (s) => ({ name: s, port: ports[s], dist: join(root, `dist-${s}`), pid: join(dir, `${s}.pid`), log: join(dir, `${s}.log`) }),
  }
}

/**
 * Read the pointer, or say which slot to use when there is no pointer yet.
 *
 * Split out from the I/O because "which slot do I deploy into" is a decision,
 * and a decision with a first-run branch is exactly the kind that is wrong
 * once and then wrong forever in a way nothing reports.
 */
export function nextSlot(pointer) {
  if (!pointer?.live || !SLOTS.includes(pointer.live)) return "blue"
  return other(pointer.live)
}

const readJson = async (p) => { try { return JSON.parse(await readFile(p, "utf8")) } catch { return null } }

/** Atomic, because the proxy reads this file and must never see half of it. */
async function writePointer(paths, value) {
  const tmp = `${paths.pointer}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8")
  await rename(tmp, paths.pointer)
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const pidOf = async (p) => { const n = Number((await readFile(p, "utf8").catch(() => "")).trim()); return Number.isFinite(n) && n > 1 ? n : null }

async function startDetached({ cmd, cwd, env, logFile, pidFile }) {
  const { openSync } = await import("node:fs")
  const out = openSync(logFile, "a")
  const [bin, ...args] = cmd.split(/\s+/)
  const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", out, out] })
  child.unref()
  await writeFile(pidFile, String(child.pid), "utf8")
  return child.pid
}

/**
 * Wait until the PUBLIC port serves `expected`.
 *
 * A flip is a file write, and a file write is not a cutover — the proxy has to
 * notice. Returning from `swap` before the public port agrees would hand
 * `prove` a race it could only lose intermittently, which is the worst kind of
 * red. So the flip is confirmed where it matters: through the door users use.
 */
async function publicServes({ base, versionPath, expected, timeoutMs = 10_000, fetchImpl = fetch }) {
  const deadline = Date.now() + timeoutMs
  let why = "never answered"
  for (;;) {
    try {
      const body = await (await fetchImpl(`${base}${versionPath}`)).text()
      if (body.includes(expected)) return { ok: true }
      why = `public port still serving ${body.slice(0, 80)}`
    } catch (err) { why = err.cause?.code ?? err.message }
    if (Date.now() >= deadline) return { ok: false, why }
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Poll one slot's OWN port until it serves `expected`, or give up. */
async function slotServes({ port, versionPath, expected, timeoutMs = 20_000, fetchImpl = fetch }) {
  const deadline = Date.now() + timeoutMs
  let why = "never answered"
  for (;;) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}${versionPath}`)
      const body = await res.text()
      if (body.includes(expected)) return { ok: true, body }
      why = `answered, but with neither the new id nor anything recognisable: ${body.slice(0, 120)}`
    } catch (err) { why = err.cause?.code ?? err.message }
    if (Date.now() >= deadline) return { ok: false, why }
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * @param {object} o
 * @param {string} o.root            project root
 * @param {number} o.publicPort      the port users hit — the proxy owns it
 * @param {string} o.versionPath     endpoint that echoes the artifact id
 * @param {string} o.startCmd        how to start ONE slot; gets PORT and VIBEUBI_DIST
 * @param {string} [o.buildCmd]      build; gets VIBEUBI_OUT pointing at the idle slot
 * @param {(root:string)=>Promise<string>} o.readArtifactId  id of the build in a slot dir
 */
export function blueGreenTarget(o) {
  const { root, publicPort, versionPath, startCmd, buildCmd, ports, stateDir, keepPreviousWarm = true, drainMs = 2000 } = o
  const paths = layout({ root, stateDir, ports })
  const base = `http://127.0.0.1:${publicPort}`
  let staged = null   // the slot this run is deploying into
  let stagedId = null

  const ensureProxy = async () => {
    await mkdir(paths.dir, { recursive: true })
    const pid = await pidOf(paths.proxyPid)
    if (pid && alive(pid)) return { started: false, pid }
    const started = await startDetached({
      cmd: `${process.execPath} ${join(HERE, "front-proxy.mjs")} ${paths.dir} ${publicPort}`,
      cwd: root, env: {}, logFile: paths.proxyLog, pidFile: paths.proxyPid,
    })
    await new Promise((r) => setTimeout(r, 400))
    if (!alive(started)) throw new Error(`the front proxy exited immediately — see ${paths.proxyLog}`)
    return { started: true, pid: started }
  }

  return {
    paths,
    proofClaim: versionPath
      ? { external: true, carriesArtifactId: true, source: `GET ${versionPath} through the PUBLIC port :${publicPort} — what a user gets, not what a slot claims` }
      : { external: true, carriesArtifactId: false, source: "no versionPath configured, so nothing observed can name a build" },

    async build() {
      await ensureProxy()
      const pointer = await readJson(paths.pointer)
      staged = nextSlot(pointer)
      const slot = paths.slot(staged)
      // The idle slot is not serving anyone, so building into it destroys
      // nothing. This is the property `process-target.build` had to fake with
      // a snapshot-and-restore dance.
      await rm(slot.dist, { recursive: true, force: true })
      if (buildCmd) {
        const [bin, ...args] = buildCmd.split(/\s+/)
        await run(bin, args, { cwd: root, env: { ...process.env, VIBEUBI_OUT: slot.dist }, maxBuffer: 64 * 1024 * 1024 })
      }
      return { staged, dist: slot.dist }
    },

    async artifactId() {
      stagedId = await o.readArtifactId(paths.slot(staged ?? "blue").dist)
      return stagedId
    },

    async previousArtifactId({ base: b = base, fetchImpl = fetch } = {}) {
      if (!versionPath) return null
      try { return (await (await fetchImpl(`${b}${versionPath}`)).text()).trim() || null } catch { return null }
    },

    /**
     * Start the staged slot, wait for it to serve, THEN flip.
     *
     * The order is the whole design. Flipping first and checking afterwards is
     * what every "zero-downtime" recipe that still drops requests does.
     */
    async swap() {
      if (!staged) throw new Error("swap before build — nothing is staged")
      const slot = paths.slot(staged)
      const old = await readJson(paths.pointer)

      const existing = await pidOf(slot.pid)
      if (existing && alive(existing)) { try { process.kill(existing, "SIGTERM") } catch {} ; await new Promise((r) => setTimeout(r, 300)) }
      await startDetached({ cmd: startCmd, cwd: root, env: { PORT: String(slot.port), VIBEUBI_DIST: slot.dist }, logFile: slot.log, pidFile: slot.pid })

      const up = await slotServes({ port: slot.port, versionPath, expected: stagedId })
      if (!up.ok) {
        // Nothing flipped, so no user ever saw this build. Say that plainly —
        // "swap failed" reads like an outage and this is the opposite.
        const tail = await readFile(slot.log, "utf8").then((t) => t.trim().split("\n").slice(-4).join(" | ")).catch(() => "")
        throw new Error(`the new build never served ${stagedId} on its own port :${slot.port} (${up.why}) — the pointer was NOT flipped, so traffic is still on ${old?.live ?? "the previous slot"}. Last log: ${tail}`)
      }

      await writePointer(paths, { live: staged, port: slot.port, artifactId: stagedId, previous: old?.live ?? null, previousPort: old?.port ?? null, previousArtifactId: old?.artifactId ?? null, at: new Date().toISOString() })
      const through = await publicServes({ base, versionPath, expected: stagedId })
      if (!through.ok) throw new Error(`the pointer says ${staged}, but the public port :${publicPort} does not serve ${stagedId} (${through.why}) — is the front proxy running? see ${paths.proxyLog}`)

      if (old?.live && old.live !== staged) {
        await new Promise((r) => setTimeout(r, drainMs))   // let in-flight requests finish
        if (!keepPreviousWarm) {
          const pid = await pidOf(paths.slot(old.live).pid)
          if (pid && alive(pid)) { try { process.kill(pid, "SIGTERM") } catch {} }
        }
      }
      return { live: staged, port: slot.port }
    },

    /** No process to restart — the flip already happened and the proxy never stopped. */
    restart: undefined,

    /**
     * Flip back. One file write.
     *
     * This only works because the previous slot was left running, which is the
     * entire reason `keepPreviousWarm` defaults to true: the memory of a second
     * copy is cheaper than an outage during the one operation you perform when
     * something is already wrong.
     */
    async rollback() {
      const now = await readJson(paths.pointer)
      if (!now?.previous) throw new Error("nothing to roll back to — this is the first deploy through this proxy")
      const back = paths.slot(now.previous)
      const pid = await pidOf(back.pid)
      if (!pid || !alive(pid)) {
        if (!existsSync(back.dist)) throw new Error(`slot ${now.previous} is gone and its build is not on disk — cannot roll back`)
        await startDetached({ cmd: startCmd, cwd: root, env: { PORT: String(back.port), VIBEUBI_DIST: back.dist }, logFile: back.log, pidFile: back.pid })
        const up = await slotServes({ port: back.port, versionPath, expected: now.previousArtifactId ?? "" })
        if (!up.ok) throw new Error(`the previous slot would not come back up: ${up.why}`)
      }
      await writePointer(paths, { live: now.previous, port: back.port, artifactId: now.previousArtifactId, previous: now.live, previousPort: now.port, previousArtifactId: now.artifactId, at: new Date().toISOString() })
      if (now.previousArtifactId) {
        const through = await publicServes({ base, versionPath, expected: now.previousArtifactId })
        if (!through.ok) throw new Error(`rolled the pointer back to ${now.previous}, but the public port does not serve ${now.previousArtifactId} (${through.why})`)
      }
      return { live: now.previous, port: back.port }
    },

    async proof({ base: b = base, expected, previous, fetchImpl = fetch }) {
      if (!versionPath) return { expected, previous, observed: "" }
      try {
        const res = await fetchImpl(`${b}${versionPath}`)
        return { expected, previous, observed: await res.text() }
      } catch (err) {
        return { expected, previous, observed: "", unreachable: err.cause?.code ?? err.message }
      }
    },

    /** For teardown in tests and `vibeubi stop`. */
    async stopAll() {
      for (const f of [paths.proxyPid, paths.slot("blue").pid, paths.slot("green").pid]) {
        const pid = await pidOf(f)
        if (pid && alive(pid)) { try { process.kill(pid, "SIGTERM") } catch {} }
      }
    },
  }
}
