/**
 * front-proxy.mjs — the one process that does NOT get redeployed.
 *
 * It owns the public port and forwards to whichever slot the pointer file
 * names. That single indirection is what removes the outage: the old shape
 * stopped the only listener and started another, so between SIGTERM and the
 * new process binding, nothing was listening — measured at 632ms for an app
 * that binds instantly and 2,110ms for one that takes 1.5s to boot. Here the
 * listener never stops. A deploy changes a word in a file.
 *
 * It also changes what a rollback IS. Rolling back used to mean renaming
 * directories and restarting — a second outage, on the unhappy path, which is
 * the worst place to put one. Here the previous slot is still running, so
 * rollback is the same word changing back.
 *
 * Two deliberate choices:
 *
 * - THE FILE IS THE TRUTH, not a message we sent. A proxy that learned the
 *   live slot from a request would forget it on restart and start forwarding
 *   to a slot that may be long dead. fs.watch gives the flip millisecond
 *   latency; the 500ms poll underneath it is there because fs.watch misses
 *   events on some filesystems, and a missed flip must cost 500ms, not
 *   forever.
 *
 * - NO KEEP-ALIVE TO UPSTREAM (`agent: false`). A pooled socket outlives the
 *   flip and would carry requests to the drained slot after the cutover.
 *   Correctness first; a project that needs the throughput can put a real
 *   proxy here, which is the point of this being one small file.
 */
import http from "node:http"
import { readFileSync, watch } from "node:fs"
import { join } from "node:path"

const [stateDir, publicPort] = process.argv.slice(2)
if (!stateDir || !publicPort) {
  console.error("usage: front-proxy.mjs <stateDir> <publicPort>")
  process.exit(2)
}
const pointerPath = join(stateDir, "pointer.json")

let pointer = null
const reload = () => {
  try {
    const next = JSON.parse(readFileSync(pointerPath, "utf8"))
    if (typeof next?.port !== "number") return
    if (pointer?.port !== next.port) console.log(`[proxy] live slot → ${next.live} :${next.port}`)
    pointer = next
  } catch { /* mid-write or absent — keep serving the last good pointer */ }
}
reload()
/**
 * Watch the DIRECTORY, not the file. Two bugs live in watching the file, and
 * the measured test caught both:
 *
 * - At the first deploy the pointer does not exist yet, so there is nothing to
 *   watch, and the proxy answered 503 for the first 500ms of its life — 28 of
 *   130 sampled requests.
 * - `writePointer` is write-then-rename, because the proxy must never read
 *   half a file. A rename replaces the inode, and an fs.watch on a file follows
 *   the inode, so the watch goes deaf after exactly one flip. On Node 22 the
 *   rollback then took longer than the test's patience — which is the honest
 *   symptom of "this only ever worked because of the poll".
 *
 * A directory watch survives both. The poll stays underneath as a backstop for
 * filesystems where watching does not work at all.
 */
try { watch(stateDir, (_e, name) => { if (!name || String(name).startsWith("pointer.json")) reload() }) } catch { /* poll only */ }
setInterval(reload, 250).unref?.()

/** 503 with a reason, because "connection refused" tells an operator nothing. */
const unavailable = (res, why) => {
  if (res.headersSent) return res.destroy()
  res.writeHead(503, { "content-type": "text/plain", "x-vibeubi-proxy": why })
  res.end(`no live slot: ${why}\n`)
}

const server = http.createServer((req, res) => {
  if (!pointer) return unavailable(res, "pointer file has never been read")
  const up = http.request(
    { host: "127.0.0.1", port: pointer.port, path: req.url, method: req.method, headers: req.headers, agent: false },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, { ...upRes.headers, "x-vibeubi-slot": pointer.live })
      upRes.pipe(res)
    },
  )
  up.on("error", (err) => unavailable(res, `slot ${pointer.live} on :${pointer.port} — ${err.code ?? err.message}`))
  req.pipe(up)
})

/** Websockets travel over the same flip, or a chat app breaks on every deploy. */
server.on("upgrade", (req, socket, head) => {
  if (!pointer) return socket.destroy()
  const up = http.request({ host: "127.0.0.1", port: pointer.port, path: req.url, method: req.method, headers: req.headers, agent: false })
  up.on("upgrade", (upRes, upSocket, upHead) => {
    socket.write(`HTTP/1.1 101 ${upRes.statusMessage}\r\n` + Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n")
    if (upHead?.length) socket.write(upHead)
    upSocket.pipe(socket).pipe(upSocket)
  })
  up.on("error", () => socket.destroy())
  if (head?.length) up.write(head)
  up.end()
})

server.listen(Number(publicPort), "0.0.0.0", () => console.log(`[proxy] listening on :${publicPort}`))
