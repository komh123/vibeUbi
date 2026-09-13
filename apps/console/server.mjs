#!/usr/bin/env node
/**
 * The console, served locally, with a button that actually runs the gate.
 *
 * The published page replays a recorded run — which is honest, and it is what
 * lets anyone see the thing without a checkout. This is the other half: the
 * same page, but `Run` spawns the real CLI and streams its output.
 *
 *   node apps/console/server.mjs --root ../system-monitor --config examples/system-monitor.config.mjs
 *
 * Read-only by construction: it can start `ubi scan` and `ubi viz`, and
 * nothing else. A console that can be talked into running an arbitrary command
 * is a remote shell with a nice font.
 */
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..", "..")
const argv = process.argv.slice(2)
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }

const ROOT = resolve(val("root", process.cwd()))
const CONFIG = val("config", "") ? resolve(val("config", "")) : ""
const PORT = Number(val("port", 7777))

/** The only commands this server may start. Not a filter over a string — a
 *  fixed list, because an allow-list over user input is how these become RCE. */
const ALLOWED = {
  scan: (layers) => ["scan", "--layer", /^S[0-7](,S[0-7])*$/.test(layers ?? "") ? layers : "S0,S2,S4"],
  viz: () => ["viz", "--format", "ir"],
  orphans: () => ["orphans"],
  plan: () => ["plan"],
}

function runUbi(name, arg, onLine, onDone) {
  const make = ALLOWED[name]
  if (!make) { onDone(2, "not an allowed command"); return }
  const args = [join(REPO, "bin", "vibeubi.mjs"), ...make(arg), "--root", ROOT]
  if (CONFIG) args.push("--config", CONFIG)
  const p = spawn(process.execPath, args, { cwd: REPO })
  let buf = ""
  const pump = (chunk) => {
    buf += chunk
    const parts = buf.split("\n"); buf = parts.pop() ?? ""
    for (const l of parts) onLine(l.replace(/\x1b\[\d+m/g, ""))
  }
  p.stdout.on("data", (c) => pump(String(c)))
  p.stderr.on("data", (c) => pump(String(c)))
  p.on("close", (code) => { if (buf) onLine(buf); onDone(code ?? 0) })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")

  if (url.pathname === "/api/run") {
    res.writeHead(200, {
      "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
    })
    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)
    send("start", { cmd: url.searchParams.get("cmd"), root: ROOT, at: new Date().toISOString() })
    runUbi(
      url.searchParams.get("cmd") ?? "scan",
      url.searchParams.get("layer"),
      (line) => send("line", { line }),
      (code, why) => { send("done", { code, why }); res.end() },
    )
    return
  }

  if (url.pathname === "/api/where") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ root: ROOT, config: CONFIG || null, live: true }))
    return
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "")
  try {
    const body = await readFile(join(HERE, file))
    const type = file.endsWith(".json") ? "application/json" : file.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain"
    res.writeHead(200, { "content-type": type }); res.end(body)
  } catch {
    res.writeHead(404); res.end("not found")
  }
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  VibeUbi console   http://127.0.0.1:${PORT}`)
  console.log(`  scanning          ${ROOT}`)
  console.log(`  config            ${CONFIG || "<root>/vibeubi.config.mjs"}`)
  console.log(`\n  Bound to 127.0.0.1 on purpose. This process can start \`ubi\` and nothing else;`)
  console.log(`  put it on 0.0.0.0 and it stops being a console and starts being a finding.\n`)
})
