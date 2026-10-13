/** Incremental delivery orchestration. Kernel verdicts remain unchanged.
 * A successful scoped delivery is evidence for its listed steps, never a full
 * verify report. Checks are selected before execution; failures never shrink it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, lstat, readdir, readlink, rm } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { testPlan, readyToRun, planOutcome, testRanVerdict } from '../../kernel/src/index.mjs'
import { runStep } from './run.mjs'
const digest = value => createHash('sha256').update(value).digest('hex')
const json = value => JSON.stringify(value, (_key, v) => typeof v === 'function' ? v.toString() : v)
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 << 20 })
export function matches(file, patterns = []) {
  const positive=patterns.filter(p=>!p.startsWith('!')), negative=patterns.filter(p=>p.startsWith('!')).map(p=>p.slice(1))
  if (negative.length && matches(file, negative)) return false
  return positive.some(pattern => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0\//g, '(?:.*/)?').replace(/\0/g, '.*')
    return new RegExp(`^${escaped}$`).test(file)
  })
}
export function deliveryMode({ full = false, major = '', majorChanges = [] } = {}) {
  const reasons = [major, ...majorChanges].filter(s => typeof s === 'string' && s.trim())
  return { mode: full || reasons.length ? 'full' : 'incremental', reasons: full ? ['Owner requested --full', ...reasons] : reasons.length ? reasons : ['Ordinary changes, including engine changes, start at build; selected post-build checks still required'] }
}
export async function atomicJson(file, data) {
  await mkdir(resolve(file, '..'), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n'); await rename(temp, file)
}
export async function sourceFiles(root) {
  return [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort()
}
async function hashPaths(root, paths, { required = false } = {}) {
  const hash = createHash('sha256')
  async function visit(name) {
    const file = resolve(root, name)
    if (relative(root, file).startsWith('..')) throw Error(`Path outside root: ${name}`)
    const stat = await lstat(file).catch(e => { if (e.code === 'ENOENT' && !required) return null; throw e })
    hash.update(name + '\0')
    if (!stat) { hash.update('missing\0'); return }
    hash.update(String(stat.mode) + '\0')
    if (stat.isSymbolicLink()) hash.update('link:' + await readlink(file))
    else if (stat.isDirectory()) for (const child of (await readdir(file)).sort()) await visit(join(name, child))
    else hash.update(await readFile(file))
  }
  for (const name of [...new Set(paths)].sort()) await visit(name)
  return hash.digest('hex')
}
export async function inputFingerprint(root, patterns, salt = '') {
  if (!patterns?.length) throw Error('Declare nonempty inputs; missing inputs cannot be reused')
  return digest(await hashPaths(root, (await sourceFiles(root)).filter(f => matches(f, patterns))) + json({ patterns, salt }))
}
export async function changedFiles(root, baseline) {
  const working = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean)
  // --name-only includes both sides of a rename; status also includes untracked.
  const unstaged = git(root, ['diff', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean)
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  void working // status errors are not silently interpreted as a clean tree.
  const committed = baseline ? git(root, ['diff', '--name-only', '--no-renames', '-z', baseline, 'HEAD']).split('\0').filter(Boolean) : await sourceFiles(root)
  return [...new Set([...committed, ...unstaged, ...untracked])].sort()
}
export async function checklist({ root, config, full = false, major = '', baseline, changed }) {
  const policy = deliveryMode({ full, major, majorChanges: config.majorChanges })
  const files = changed ?? await changedFiles(root, baseline)
  const steps = config.steps ?? [], features = config.features ?? []
  for (const step of steps) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(step.id)) throw Error('Step ids must be safe filenames')
    if (step.phase === 'preflight' && (step.mutates || (step.after ?? []).some(id => steps.find(s => s.id === id)?.phase !== 'preflight'))) throw Error('Preflight must be read-only and depend only on preflight steps')
  }
  const validity = testPlan(steps)
  if (!validity.ok) throw Error(validity.violations.join('\n'))
  if (!steps.length || !features.length) throw Error('Declare delivery steps and features before shipping')
  const ids = new Set(steps.map(s => s.id))
  for (const feature of features) {
    if (!feature.id || !feature.covers?.length || !feature.steps?.length || feature.steps.some(id => !ids.has(id))) throw Error(`Incomplete feature declaration: ${feature.id}`)
  }
  const selectedFeatures = features.filter(f => policy.mode === 'full' || !baseline || f.always || files.some(p => matches(p, f.covers)))
  const selected = new Set(steps.filter(s => s.always || (s.fullOnly && policy.mode === 'full')).map(s => s.id))
  for (const f of selectedFeatures) for (const id of f.steps) if (!steps.find(s => s.id === id).fullOnly || policy.mode === 'full') selected.add(id)
  if (policy.mode === 'full') for (const s of steps) selected.add(s.id)
  const visit = id => { for (const dep of steps.find(s => s.id === id).after ?? []) if (!selected.has(dep)) { selected.add(dep); visit(dep) } }
  for (const id of selected) visit(id)
  // Full-only prerequisites must not accidentally drag full verify into normal builds.
  if (policy.mode !== 'full' && steps.some(s => s.fullOnly && selected.has(s.id))) throw Error('Ordinary delivery depends on a full-only step; correct the dependency declaration')
  const uncovered = files.filter(p => !features.some(f => matches(p, f.covers)))
  const result = { kind: 'delivery-checklist', ...policy, baseline: baseline ?? null, changed: files, uncovered,
    features: features.map(f => ({ ...f, selected: selectedFeatures.includes(f), status: selectedFeatures.includes(f) ? 'pending' : 'not-selected' })),
    steps: steps.map(s => ({ id: s.id, after: s.after ?? [], selected: selected.has(s.id), phase: s.phase ?? 'acceptance', fullOnly: !!s.fullOnly })),
    updatedAt: new Date().toISOString() }
  await atomicJson(join(root, '.vibeubi', 'checklist.json'), result)
  return result
}
export async function deliver({ root, config, full = false, major = '', baseline, changed, emit = () => {}, execute }) {
  const home = join(root, '.vibeubi', 'delivery'); await mkdir(home, { recursive: true })
  const lock = join(home, 'lock.json')
  try { await writeFile(lock, json({ pid: process.pid }), { flag: 'wx' }) }
  catch (e) {
    if (e.code !== 'EEXIST') throw e
    const old = JSON.parse(await readFile(lock, 'utf8'))
    let alive = true; try { process.kill(old.pid, 0) } catch (err) { if (err.code === 'ESRCH') alive = false; else throw err }
    if (alive) throw Error(`Delivery already running (pid ${old.pid})`)
    await rm(lock); return deliver({ root, config, full, major, baseline, changed, emit, execute })
  }
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
  const outDir = join(home, runId); await mkdir(outDir)
  const report = { kind: 'delivery', countsAsFullVerification: false, runId, outDir, status: 'planning', steps: {}, startedAt: new Date().toISOString() }
  const save = async () => { report.updatedAt = new Date().toISOString(); await atomicJson(join(outDir, 'report.json'), report); await atomicJson(join(home, 'status.json'), report); emit({ kind: 'status', report }) }
  let beat
  try {
    const previous = await readFile(join(home, 'baseline.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null })
    const plan = await checklist({ root, config, full, major, baseline: baseline ?? previous?.commit, changed })
    Object.assign(report, { plan, mode: plan.mode, status: 'running', configHash: digest(json(config)) })
    await save()
    if (plan.uncovered.length) throw Error(`Update feature checklist for uncovered paths: ${plan.uncovered.join(', ')}`)
    const selected = new Set(plan.steps.filter(s => s.selected).map(s => s.id))
    const steps = config.steps.filter(s => selected.has(s.id))
    const ordered = testPlan(steps).order
    const sourceList = async () => (await sourceFiles(root)).filter(f => !matches(f, config.generated ?? []))
    const files = await sourceList()
    const sourceBefore = await hashPaths(root, files)
    const cacheDir = join(home, 'cache'); await mkdir(cacheDir, { recursive: true })
    const statuses = {}, keys = {}
    const t0 = Date.now(), budget = config.totalBudgetMs ?? 3 * 60 * 60 * 1000
    const run = execute ?? (async (s, context) => {
      if (!Array.isArray(s.cmd) || !s.cmd.length) throw Error(`Missing command for ${s.id}`)
      const r = await runStep(s.id, s.cmd[0], s.cmd.slice(1), { cwd: root, outDir, timeoutMs: context.timeoutMs, env: s.env ?? {}, heapMb: s.heapMb })
      if (r.code !== 0 || r.timedOut) throw Error(`${s.id}: ${r.timedOut ? 'timed out' : `exit ${r.code}`} — ${r.out.slice(-1200)}`)
      if (s.expectsTests) { const v = testRanVerdict(s.id, r.out); if (!v.ok) throw Error(v.reason) }
      return { ok: true, log: join(outDir, `step-${s.id}.out`) }
    })
    // Preflight is read-only. Run every independent prerequisite before any build.
    const order = [...ordered.filter(id => steps.find(s => s.id === id).phase === 'preflight'), ...ordered.filter(id => steps.find(s => s.id === id).fullOnly && steps.find(s => s.id === id).phase !== 'preflight'), ...ordered.filter(id => !steps.find(s => s.id === id).fullOnly && steps.find(s => s.id === id).phase !== 'preflight')]
    for (const id of order) {
      const s = steps.find(s => s.id === id)
      if (!readyToRun(s, statuses)) continue
      if (s.phase !== 'preflight' && steps.some(p => p.phase === 'preflight' && statuses[p.id]?.status !== 'pass')) continue
      if (!s.fullOnly && s.phase !== 'preflight' && steps.some(p => p.fullOnly && statuses[p.id]?.status !== 'pass')) continue
      if (Date.now() - t0 >= budget) { statuses[id] = { status: 'not-run', reason: 'Total delivery budget exceeded' }; continue }
      const row = report.steps[id] = { status: 'running', phase: s.phase ?? 'acceptance', startedAt: new Date().toISOString() }
      await save(); emit({ kind: 'step', id, state: 'run' })
      // Heartbeats update a separate file to avoid racing report snapshots.
      beat = setInterval(() => { atomicJson(join(home, 'heartbeat.json'), { runId, pid: process.pid, step: id, at: new Date().toISOString() }).catch(() => {}) }, 15000)
      try {
        if (sourceBefore !== await hashPaths(root, await sourceList())) throw Error('Source changed during delivery; stop before consuming stale evidence')
        const key = await inputFingerprint(root, s.inputs ?? ['**'], { step: s, deps: (s.after ?? []).map(d => keys[d]), runtime: process.version, context: config.context ?? {} })
        const cacheFile = join(cacheDir, digest(id) + '.json')
        const cached = await readFile(cacheFile, 'utf8').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null })
        const reusable = plan.mode !== 'full' && s.reuse === true && !s.mutates && s.phase !== 'preflight' && s.outputs?.length && cached?.key === key && cached?.status === 'pass'
        let reused = false, outputHash = null
        if (reusable) {
          try { outputHash = await hashPaths(root, s.outputs, { required: true }); reused = outputHash === cached.outputHash } catch { /* missing artifacts must be rebuilt */ }
        }
        if (!reused) {
          const result = await run(s, { root, outDir, report, timeoutMs: Math.min(s.timeoutMs ?? 30 * 60 * 1000, budget - (Date.now() - t0)), emit })
          if (result?.ok !== true) throw Error(`${id} produced no affirmative execution evidence`)
          if (sourceBefore !== await hashPaths(root, await sourceList())) throw Error('Source changed while step ran; evidence invalidated')
          if (s.outputs?.length) outputHash = await hashPaths(root, s.outputs, { required: true })
          row.evidence = result
          if (s.reuse === true && s.outputs?.length && !s.mutates) await atomicJson(cacheFile, { key, outputHash, status: 'pass', runId })
        }
        Object.assign(row, { status: 'pass', execution: reused ? 'reused' : 'ran', ...(reused ? { fromRun: cached.runId } : {}), key, outputHash })
        keys[id] = s.phase === 'preflight' ? digest(json(s)) : digest(key + (outputHash ?? ''))
      } catch (error) { Object.assign(row, { status: 'fail', reason: error.message }); emit({ kind: 'failure', id, reason: error.message }) }
      finally { clearInterval(beat); row.finishedAt = new Date().toISOString(); statuses[id] = row; await save() }
    }
    const outcome = planOutcome(steps, statuses)
    report.outcome = outcome
    for (const s of steps) if (!report.steps[s.id]) report.steps[s.id] = { status: 'blocked', reason: 'Prerequisite failed or not run; see outcome' }
    report.status = steps.length > 0 && steps.every(s => report.steps[s.id].status === 'pass') ? 'passed' : 'failed'
    report.finishedAt = new Date().toISOString()
    if (report.status === 'passed') await atomicJson(join(home, 'baseline.json'), { commit: git(root, ['rev-parse', 'HEAD']).trim(), runId, mode: report.mode })
    await save(); return report
  } catch (error) { report.status = 'failed'; report.error = error.message; report.finishedAt = new Date().toISOString(); await save(); return report }
  finally { clearInterval(beat); await rm(lock, { force: true }) }
}
