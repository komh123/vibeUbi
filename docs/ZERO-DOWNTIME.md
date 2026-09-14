# The outage nobody measured

The default deploy target stops the process and starts another one. Between
those two events nothing is listening. That is not a design flaw anyone hid —
it is what "restart the service" means — but nobody in this project had put a
number on it, so here are the numbers, taken on a real restart with a poller
hitting the port every 10ms:

| the app binds its port after | outage |
| --- | --- |
| 0ms (binds immediately) | **632ms** |
| 300ms | **926ms** |
| 1500ms | **2,110ms** |

632ms is the floor, and it is written down rather than emergent:
`restart()` sends SIGTERM, waits 400ms, and SIGKILLs whatever is left.

## The bug that was hiding inside it

`restart()` then waits a fixed 1,200ms and checks the process is **alive**.
Alive is not **serving**. For the third row above, `restart` returned while the
service was still 500ms from binding — and `proof` was a single fetch with no
retry, so it fired into a closed port, threw `ECONNREFUSED`, and the gate rolled
the deploy back.

A healthy app, rejected for being slow to start. A gate that punishes the
correct thing is worse than no gate, and this one did it silently and every
single time.

Fixed by `readyObservation()`: it polls the adapter's proof until the service
answers or a bounded deadline passes, then hands the **last** observation to
`deployProof`, which judges it once. **It retries the observation, not the
verdict.** A swap that never took still fails; it just fails at the deadline
instead of instantly, and says how long it waited.

| app boot | before | after |
| --- | --- | --- |
| 0ms | proves | proves (6ms) |
| 1,500ms | **rolled back** | proves (562ms) |
| 3,000ms | **rolled back** | proves (2,052ms) |
| old process stuck on the port | fails | **still fails**, after 3.1s |

## Removing the outage

Two shapes measure 0ms on this machine. Only one of them is compatible with
being a deploy gate.

### SO_REUSEPORT — 0ms, and unusable here

Node 22.12+ on Linux 3.9+ accepts `listen({ port, reusePort: true })`, so the
new process can bind the port the old one is already on and the kernel spreads
connections across both. Measured: 202 polls across a full changeover, **0
down**.

Then the overlap window was sampled, 40 requests:

```
{"new1": 20, "old0": 20}
```

Exactly half. The kernel round-robins, so **during the changeover `proof` is a
coin flip** — and a pipeline whose evidence is a coin flip is the thing this
product exists to remove. SO_REUSEPORT is a fine transport. It is not a deploy
gate.

### Blue-green — 0ms, and it makes the gate stronger

`packages/adapters/src/blue-green.mjs`. Two slots, each a full build and its own
process on its own loopback port, and a proxy on the public port forwarding to
whichever slot a pointer file names. A deploy builds into the **idle** slot,
starts it, waits until it serves the new id **on its own port**, and only then
flips the pointer.

Measured, with a poller on the public port across a deploy **and** a rollback:

| app boot | samples | dropped | rollback |
| --- | --- | --- | --- |
| 0ms | 118 | **0** | **17ms** |
| 1,500ms | 305 | **0** | **34ms** |

Three consequences matter more than the zero:

1. **A build that does not boot never reaches a user.** The old shape moved the
   new build into place and restarted, so a build that crashed on startup was
   already live and serving errors while the pipeline worked out that it should
   not be. Here the flip is last and gated on the new slot answering.
2. **Rollback is a pointer flip** — 17ms, no restart, no second outage. The old
   shape put an outage on the unhappy path, which is the worst place for one.
3. **The proof gets more honest.** `proof` reads through the *public* port, so
   what it observes is what a user gets. Reading a slot directly would prove a
   process is up while the proxy still points elsewhere.

Cost: two copies of the app resident at once, and one more hop.

## What the measured test caught

The claim is "no outage", so the test measures rather than asserts. It ran a
real proxy, real slots, a real flip and a real rollback with an 8ms poller — and
failed twice, on two bugs that a non-measuring test would have shipped:

- **28 of 130 requests got 503.** The proxy watched the pointer *file*, which
  does not exist yet at the first deploy, so it had no route for the first
  500ms of its life.
- **`fs.watch` goes deaf after exactly one flip.** The pointer is written with
  write-then-rename, so the proxy never reads half a file — and a rename
  replaces the inode that `fs.watch` is holding. The rollback then only worked
  because of the 500ms backstop poll.

Both fixed by watching the directory. And `swap()` now confirms the **public**
port serves the new id before returning, so a flip is a cutover rather than a
hope.

## Using it

```js
import { blueGreenTarget } from "vibeubi/packages/adapters/src/blue-green.mjs"

const target = blueGreenTarget({
  root: "/path/to/project",
  publicPort: 3401,                    // what users hit; the proxy owns it
  ports: { blue: 4101, green: 4102 },  // the slots, loopback only
  versionPath: "/api/version",         // must echo the id stamped INTO the build
  buildCmd: "npm run build",           // gets VIBEUBI_OUT = the idle slot
  startCmd: "node server/index.js",    // gets PORT and VIBEUBI_DIST
  readArtifactId: async (dist) => readFileSync(join(dist, "BUILD_ID"), "utf8").trim(),
  keepPreviousWarm: true,              // what makes rollback 17ms
  drainMs: 2000,                       // in-flight requests finish after a flip
})
```

Your app must read `process.env.PORT` and serve from `process.env.VIBEUBI_DIST`.
That is the whole contract.

**Not covered:** the proxy uses `agent: false`, so there is no keep-alive to the
upstream — a pooled socket outlives a flip and would carry requests to the
drained slot. Correctness over throughput; a project that needs the throughput
puts nginx or Caddy in that position, which is why the proxy is one small file.
