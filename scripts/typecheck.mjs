#!/usr/bin/env node
/**
 * Run tsc, then prove it LOOKED at the whole tree.
 *
 * `tsc -p … && echo ok` is the shape a peer session measured the cost of: their
 * root config excluded a whole runtime, so the service on a user's machine went
 * four months without a type check while exiting 0 every time. The first real
 * check found six defects.
 *
 * This tree is currently 2 TypeScript files and `include` names both — so today
 * the guard finds nothing. That is the point: the day somebody adds
 * `packages/adapters/src/foo.d.ts` and the `include` does not match it, tsc
 * still exits 0, and without this nothing says so.
 *
 * The verdict is computed from what the TOOL printed (`--listFiles`), never
 * from this script's opinion — the same peer had claimed a type check passed
 * while two errors stood, and switched to reading only tool output afterwards.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { relative, resolve } from "node:path"
import { coveredVerdict } from "../packages/kernel/src/index.mjs"
const run = promisify(execFile)

const ROOT = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..")
const rel = (p) => relative(ROOT, p).replaceAll("\\", "/")

const tsc = async (args) => {
  try { return (await run("npx", ["tsc", ...args], { cwd: ROOT, maxBuffer: 32 << 20 })).stdout }
  catch (e) { process.stdout.write((e.stdout ?? "") + (e.stderr ?? "")); process.exit(e.code ?? 1) }
}

const listed = (await tsc(["-p", "tsconfig.types.json", "--listFiles"]))
  .split("\n").map((l) => l.trim()).filter(Boolean)
  .filter((p) => p.startsWith(ROOT) && !p.includes("node_modules"))
  .map(rel)

const tracked = (await run("git", ["ls-files"], { cwd: ROOT })).stdout
  .split("\n").map((l) => l.trim())
  .filter((p) => /\.tsx?$/.test(p) && !p.endsWith(".json"))

const v = coveredVerdict({ step: "typecheck", read: listed, expected: tracked, how: "npx tsc -p tsconfig.types.json --listFiles" })
if (!v.ok) {
  console.error(`✗ ${v.reason}`)
  console.error(`  add them to tsconfig.types.json's \`include\`, or say in that file why they are excluded`)
  process.exit(1)
}
console.log(`✓ typecheck covered ${v.checked}/${tracked.length} TypeScript file(s)`)
