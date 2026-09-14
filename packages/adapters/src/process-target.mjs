/**
 * process-target.mjs — build, swap, restart and roll back a local service.
 *
 * Shared by the adapters, because the SHAPE is the same everywhere even when
 * the commands are not: build into a scratch directory, rename it into place
 * keeping the old one, restart, and then go and look from outside.
 *
 * Two properties are load-bearing and neither is obvious:
 *
 * 1. THE BUILD NEVER WRITES INTO THE LIVE DIRECTORY. It builds into `<dist>-new`
 *    and the swap is a rename. A build that writes in place has already
 *    destroyed the thing you would roll back to, before anyone judged it.
 *
 * 2. RESTART RETURNING 0 IS NOT EVIDENCE. This module does not report success
 *    from an exit code — it hands control back and the kernel's `deployProof`
 *    decides, from what the running service actually serves.
 */
import { rename, rm, mkdir, readFile, writeFile, cp } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
const run = promisify(execFile)

export function distPaths(root, dist = "dist") {
  return { live: join(root, dist), next: join(root, `${dist}-new`), prev: join(root, `${dist}-prev`) }
}

/** The renames, in order, as data — so `--plan` can print them and a test can assert them. */
export function swapMoves(p) {
  return [
    { from: p.live, to: p.prev, why: "keep the build we are replacing, so rollback has something to restore" },
    { from: p.next, to: p.live, why: "put the new build in place" },
  ]
}
export function rollbackMoves(p) {
  return [
    { from: p.live, to: p.next, why: "set the rejected build aside (do not delete — it is the evidence)" },
    { from: p.prev, to: p.live, why: "restore the build that was serving before" },
  ]
}

/**
 * Build into a scratch directory — even when the tool refuses to.
 *
 * Most bundlers CLEAN their output directory and write in place. Vite does.
 * So pointing an env var at a scratch dir and hoping is not enough: by the
 * time you notice the tool ignored you, it has already emptied the live
 * artifact — the exact thing a rollback needs — before anything judged the
 * new one.
 *
 * That happened here on the first real run: the build wiped `dist`, the swap
 * moved the gutted `dist` aside as "previous", and the rollback restored a
 * directory with the artifact id missing. The rollback worked and was
 * unprovable, which is the worst of the three possible outcomes.
 *
 * So: SNAPSHOT FIRST. Copy the live artifact out of the way before the build
 * runs, let the tool do whatever it likes, then put the pieces where they
 * belong. A build must never be able to destroy the thing you would roll back
 * to.
 */
export async function build({ root, cmd, env = {}, distDir = "dist" }) {
  const p = distPaths(root, distDir)
  await rm(p.next, { recursive: true, force: true })

  const snapshot = `${p.live}-snapshot`
  await rm(snapshot, { recursive: true, force: true })
  const hadLive = existsSync(p.live)
  if (hadLive) await cp(p.live, snapshot, { recursive: true })

  const [bin, ...args] = cmd.split(/\s+/)
  try {
    await run(bin, args, { cwd: root, env: { ...process.env, ...env, VIBEUBI_OUT: p.next }, maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    // A failed build must not leave the live artifact in whatever half-state
    // the tool stopped at.
    if (hadLive) { await rm(p.live, { recursive: true, force: true }); await rename(snapshot, p.live) }
    throw err
  }

  if (!existsSync(p.next)) {
    // The tool wrote in place. Move its output to the scratch dir and put the
    // snapshot back, so `live` is untouched until `swap` says so.
    if (existsSync(p.live)) await rename(p.live, p.next)
    if (hadLive) await rename(snapshot, p.live)
  } else {
    await rm(snapshot, { recursive: true, force: true })
  }
  return p
}

export async function swap({ root, distDir = "dist" }) {
  const p = distPaths(root, distDir)
  if (!existsSync(p.next)) throw new Error(`nothing to swap: ${p.next} does not exist`)
  await rm(p.prev, { recursive: true, force: true })
  for (const m of swapMoves(p)) {
    if (existsSync(m.from)) await rename(m.from, m.to)
  }
  return p
}

export async function rollback({ root, distDir = "dist" }) {
  const p = distPaths(root, distDir)
  if (!existsSync(p.prev)) throw new Error(`no previous build to restore: ${p.prev} does not exist`)
  await rm(p.next, { recursive: true, force: true })
  for (const m of rollbackMoves(p)) {
    if (existsSync(m.from)) await rename(m.from, m.to)
  }
  return p
}

/**
 * Restart a locally supervised process.
 *
 * Deliberately dumb: kill the pid we wrote down, start the command again,
 * write the new pid. No supervisor, no systemd — this is the shape that works
 * on a laptop and in CI, and the k8s adapter overrides it.
 *
 * It reports only that it DID things. Whether the deploy took is `deployProof`'s
 * question, and this module is not allowed to answer it.
 */
export async function restart({ root, cmd, pidFile = ".vibeubi/service.pid", logFile = ".vibeubi/service.log", env = {}, waitMs = 1200 }) {
  const pidPath = join(root, pidFile)
  await mkdir(join(root, ".vibeubi"), { recursive: true })

  if (existsSync(pidPath)) {
    const old = Number((await readFile(pidPath, "utf8")).trim())
    if (Number.isFinite(old) && old > 1) {
      try { process.kill(old, "SIGTERM") } catch { /* already gone */ }
      // Give it a moment, then make sure. A restart that silently left the old
      // process holding the port is the exact failure this project is named
      // after, wearing a different hat.
      await new Promise((r) => setTimeout(r, 400))
      try { process.kill(old, 0); process.kill(old, "SIGKILL") } catch { /* it exited */ }
    }
  }

  const { openSync } = await import("node:fs")
  const out = openSync(join(root, logFile), "a")
  const [bin, ...args] = cmd.split(/\s+/)
  const child = spawn(bin, args, { cwd: root, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", out, out] })
  child.unref()
  await writeFile(pidPath, String(child.pid), "utf8")
  await new Promise((r) => setTimeout(r, waitMs))

  /**
   * Is the thing we started still alive?
   *
   * `spawn` succeeding means a process was created, not that it survived. A
   * service whose port is still held by its predecessor starts, prints
   * EADDRINUSE and exits — and without this check `restart` reports success
   * while the OLD process carries on serving the OLD build. `deployProof`
   * catches it either way, but it catches it two steps later and blames the
   * swap; saying it here names the actual cause.
   */
  let alive = true
  try { process.kill(child.pid, 0) } catch { alive = false }
  if (!alive) {
    const why = await readFile(join(root, logFile), "utf8").then((t) => t.trim().split("\n").slice(-4).join(" | ")).catch(() => "")
    throw new Error(`the service exited immediately after restart — the old process may still hold the port. Last log lines: ${why}`)
  }
  return { pid: child.pid }
}

export async function stop({ root, pidFile = ".vibeubi/service.pid" }) {
  const pidPath = join(root, pidFile)
  if (!existsSync(pidPath)) return { stopped: false }
  const pid = Number((await readFile(pidPath, "utf8")).trim())
  try { process.kill(pid, "SIGTERM") } catch { return { stopped: false } }
  await new Promise((r) => setTimeout(r, 300))
  try { process.kill(pid, 0); process.kill(pid, "SIGKILL") } catch { /* gone */ }
  await rm(pidPath, { force: true })
  return { stopped: true, pid }
}
