/** Incremental delivery orchestration. Kernel verdicts remain unchanged.
 * A successful scoped delivery is evidence for its listed steps, never a full
 * verify report. Checks are selected before execution; failures never shrink it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, lstat, readdir, readlink, realpath, rm } from 'node:fs/promises'
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
import { testPlan, readyToRun, planOutcome, testRanVerdict, globMatches, inputClass, splitInputs } from '../../kernel/src/index.mjs'
import { runStep } from './run.mjs'
const digest = value => createHash('sha256').update(value).digest('hex')
const json = value => JSON.stringify(value, (_key, v) => typeof v === 'function' ? v.toString() : v)
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 << 20 })
// The glob matcher lives in the kernel now (inputs.mjs); this export keeps the old import path working.
export const matches = globMatches
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
  const outputRoot = required ? await realpath(root) : null
  const outside = path => path === '..' || path.startsWith('..' + sep) || isAbsolute(path)
  async function visit(name, ancestors = new Set()) {
    const file = resolve(root, name)
    if (outside(relative(root, file))) throw Error(`Path outside root: ${name}`)
    const stat = await lstat(file).catch(e => { if (e.code === 'ENOENT' && !required) return null; throw e })
    hash.update(name + '\0')
    if (!stat) { hash.update('missing\0'); return }
    hash.update(String(stat.mode) + '\0')
    const actual = required ? await realpath(file) : file
    if (required && outside(relative(outputRoot, actual))) throw Error(`Output resolves outside root: ${name}`)
    if (stat.isSymbolicLink()) {
      hash.update('link:' + await readlink(file))
      // Source pins describe the tracked link. Output pins additionally prove
      // the bytes it resolves to; a link name alone cannot establish an artifact.
      if (required) await visit(relative(outputRoot, actual), ancestors)
    } else if (stat.isDirectory()) {
      if (ancestors.has(actual)) throw Error(`Output directory cycle: ${name}`)
      const lineage = new Set(ancestors).add(actual)
      for (const child of (await readdir(file)).sort()) await visit(join(name, child), lineage)
    }
    else hash.update(await readFile(file))
  }
  for (const name of [...new Set(paths)].sort()) await visit(name)
  return hash.digest('hex')
}
/** `keep` optionally narrows the matched files further (a step that keys on buildInputs only). */
export async function inputFingerprint(root, patterns, salt = '', keep) {
  if (!patterns?.length) throw Error('Declare nonempty inputs; missing inputs cannot be reused')
  return digest(await hashPaths(root, (await sourceFiles(root)).filter(f => matches(f, patterns) && (!keep || keep(f)))) + json({ patterns, salt }))
}
// Injected observers get the same cancellation/deadline contract as commands.
// A callback must cooperate with its signal to stop side effects; a late return
// can never become evidence even if the callback ignores cancellation.
async function boundedObserver(observe, { signal, timeoutMs }) {
  const controller = new AbortController()
  let timer, onAbort
  try {
    return await new Promise((resolve, reject) => {
      const stop = reason => { controller.abort(reason); reject(reason) }
      onAbort = () => stop(new Error('Delivery interrupted during identity observation'))
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => stop(new Error('Identity observation timed out')), timeoutMs)
      Promise.resolve().then(() => observe(controller.signal)).then(resolve, reject)
    })
  } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
}
/** Observe a step's artifact identity (image digest, BUILD_ID, ...) from its declared `identity` command. */
async function observeIdentity(root, s, identify, { outDir, signal, timeoutMs }) {
  if (signal.aborted) throw Error('Delivery interrupted before identity observation')
  timeoutMs = Math.min(60000, timeoutMs)
  if (!(timeoutMs > 0)) throw Error('Identity observation has no remaining budget')
  let raw
  if (identify) raw = await boundedObserver(abortSignal => identify(s, { root, signal: abortSignal, timeoutMs }), { signal, timeoutMs })
  else {
    // Separate attempts retain their own stdout/stderr logs; failed reuse output
    // must not be prepended to the fresh identity after a legitimate rebuild.
    const logs = join(outDir, 'identity', s.id, randomUUID())
    await mkdir(logs, { recursive: true })
    const result = await runStep('probe', s.identity[0], s.identity.slice(1), {
      cwd: root, outDir: logs, timeoutMs, signal, env: s.env ?? {}, heapMb: s.heapMb, captureStdout: true,
    })
    if (signal.aborted) throw Error('Delivery interrupted during identity observation')
    if (result.timedOut || result.code !== 0) throw Error(`${s.id}: identity ${result.timedOut ? 'timed out' : `exited ${result.code}`}`)
    raw = result.stdout
  }
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (!id) throw Error(`${s.id}: identity probe returned nothing; an artifact with no observable identity cannot be pinned`)
  return id
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
function withAfter(step, after) {
  const declared = step.after ?? []
  return after.length === declared.length && after.every((id, i) => id === declared[i]) ? step : { ...step, after }
}
// Barriers are prerequisites, not a second scheduler hidden from the plan.
// Compile selected steps only: full-only checks are absent in incremental runs.
function deliveryPlanSteps(steps) {
  const preflight = steps.filter(s => s.phase === 'preflight').map(s => s.id)
  const full = steps.filter(s => s.fullOnly).map(s => s.id)
  return steps.map(s => s.phase === 'preflight' ? s : withAfter(s,
    [...new Set([...(s.after ?? []), ...preflight, ...(s.fullOnly ? [] : full)])]))
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
  const selectedFeatures = features.filter(f => policy.mode === 'full' || (!f.excludedReason && (!baseline || f.always || files.some(p => matches(p, f.covers)))))
  const selected = new Set(steps.filter(s => s.always || (s.fullOnly && policy.mode === 'full')).map(s => s.id))
  for (const f of selectedFeatures) for (const id of f.steps) if (!steps.find(s => s.id === id).fullOnly || policy.mode === 'full') selected.add(id)
  if (policy.mode === 'full') for (const s of steps) selected.add(s.id)
  const visit = id => { for (const dep of steps.find(s => s.id === id).after ?? []) if (!selected.has(dep)) { selected.add(dep); visit(dep) } }
  for (const id of selected) visit(id)
  // Full-only prerequisites must not accidentally drag full verify into normal builds.
  if (policy.mode !== 'full' && steps.some(s => s.fullOnly && selected.has(s.id))) throw Error('Ordinary delivery depends on a full-only step; correct the dependency declaration')
  const planned = deliveryPlanSteps(steps.filter(s => selected.has(s.id)))
  const effective = testPlan(planned)
  if (!effective.ok) throw Error(`Invalid delivery barriers: ${effective.violations.join('\n')}`)
  const plannedById = new Map(planned.map(s => [s.id, s]))
  const uncovered = files.filter(p => !features.some(f => matches(p, f.covers)))
  const result = { kind: 'delivery-checklist', ...policy, baseline: baseline ?? null, changed: files, uncovered,
    features: features.map(f => ({ ...f, selected: selectedFeatures.includes(f), status: selectedFeatures.includes(f) ? 'pending' : f.excludedReason ? 'excluded' : 'not-selected' })),
    steps: steps.map(s => ({ id: s.id, after: (plannedById.get(s.id) ?? s).after ?? [], selected: selected.has(s.id), phase: s.phase ?? 'acceptance', fullOnly: !!s.fullOnly })),
    updatedAt: new Date().toISOString() }
  await atomicJson(join(root, '.vibeubi', 'checklist.json'), result)
  return result
}
export async function deliver({ root, config, full = false, major = '', baseline, changed, emit = () => {}, execute, identify }) {
  const home = join(root, '.vibeubi', 'delivery'); await mkdir(home, { recursive: true })
  const lock = join(home, 'lock.json')
  try { await writeFile(lock, json({ pid: process.pid }), { flag: 'wx' }) }
  catch (e) {
    if (e.code !== 'EEXIST') throw e
    const old = JSON.parse(await readFile(lock, 'utf8'))
    let alive = true; try { process.kill(old.pid, 0) } catch (err) { if (err.code === 'ESRCH') alive = false; else throw err }
    if (alive) throw Error(`Delivery already running (pid ${old.pid})`)
    await rm(lock); return deliver({ root, config, full, major, baseline, changed, emit, execute, identify })
  }
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
  const outDir = join(home, runId); await mkdir(outDir)
  const report = { kind: 'delivery', countsAsFullVerification: false, runId, outDir, status: 'planning', steps: {}, startedAt: new Date().toISOString() }
  const save = async () => {
    if (report.plan) {
      for (const feature of report.plan.features) {
        if (!feature.selected) continue
        const relevant=feature.steps.filter(id=>report.plan.steps.some(s=>s.id===id&&s.selected))
        feature.status=relevant.some(id=>report.steps[id]?.status==='fail')?'fail':relevant.length&&relevant.every(id=>report.steps[id]?.status==='pass')?'pass':report.status==='failed'?'blocked':'pending'
      }
      await atomicJson(join(root,'.vibeubi/checklist.json'),{...report.plan,execution:report.steps,status:report.status})
    }
    report.updatedAt = new Date().toISOString(); await atomicJson(join(outDir, 'report.json'), report); await atomicJson(join(home, 'status.json'), report); emit({ kind: 'status', report }) }
  let beat
  const controller=new AbortController()
  const interrupted=signal=>{ report.interruptedBy=signal;controller.abort(new Error(signal)) }
  const onTerm=()=>interrupted('SIGTERM'),onInt=()=>interrupted('SIGINT')
  process.once('SIGTERM',onTerm);process.once('SIGINT',onInt)
  try {
    const previous = await readFile(join(home, 'baseline.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null })
    const plan = await checklist({ root, config, full, major, baseline: baseline ?? previous?.commit, changed })
    Object.assign(report, { plan, mode: plan.mode, status: 'running', configHash: digest(json(config)) })
    await save()
    if (plan.uncovered.length) throw Error(`Update feature checklist for uncovered paths: ${plan.uncovered.join(', ')}`)
    const selected = new Set(plan.steps.filter(s => s.selected).map(s => s.id))
    const plannedById = new Map(plan.steps.map(s => [s.id, s]))
    const steps = config.steps.filter(s => selected.has(s.id)).map(s => withAfter(s, plannedById.get(s.id).after))
    const ordered = testPlan(steps).order
    const sourceList = async () => (await sourceFiles(root)).filter(f => !matches(f, config.generated ?? []))
    const files = await sourceList()
    const sourceBefore = await hashPaths(root, files)
    const assertSourceUnchanged = async () => {
      if (sourceBefore !== await hashPaths(root, await sourceList())) throw Error('Source changed during delivery; evidence invalidated')
    }
    // Two halves of the tree: what can change a build product, and what can only change a test.
    // With no `testInputs` every file is a build input and the test half is empty (the old behaviour).
    const rules = { testInputs: config.testInputs ?? [], buildInputs: config.buildInputs ?? [] }
    const split = splitInputs(files, rules)
    Object.assign(report, { sourceTree: sourceBefore, buildInputsHash: await hashPaths(root, split.build), testInputsHash: await hashPaths(root, split.test) })
    await save()
    const cacheDir = join(home, 'cache'); await mkdir(cacheDir, { recursive: true })
    const statuses = {}, keys = {}
    const t0 = Date.now(), budget = config.totalBudgetMs ?? 3 * 60 * 60 * 1000
    const assertDeliveryActive = () => {
      if (controller.signal.aborted) throw Error('Delivery interrupted')
      if (Date.now() - t0 >= budget) throw Error('Total delivery budget exceeded')
    }
    const run = execute ?? (async (s, context) => {
      if (!Array.isArray(s.cmd) || !s.cmd.length) throw Error(`Missing command for ${s.id}`)
      const r = await runStep(s.id, s.cmd[0], s.cmd.slice(1), { cwd: root, outDir, timeoutMs: context.timeoutMs, env: s.env ?? {}, heapMb: s.heapMb, signal:controller.signal })
      if (controller.signal.aborted) throw Error('Delivery interrupted')
      if (r.code !== 0 || r.timedOut) throw Error(`${s.id}: ${r.timedOut ? 'timed out' : `exit ${r.code}`} — ${r.out.slice(-1200)}`)
      if (s.expectsTests) { const v = testRanVerdict(s.id, r.out); if (!v.ok) throw Error(v.reason) }
      return { ok: true, log: join(outDir, `step-${s.id}.out`) }
    })
    // One validated graph controls execution, cache dependencies and outcomes.
    for (const id of ordered) {
      const s = steps.find(s => s.id === id)
      if (!readyToRun(s, statuses)) continue
      if(controller.signal.aborted){statuses[id]={status:'not-run',reason:'Delivery interrupted'};continue}
      if (Date.now() - t0 >= budget) { statuses[id] = { status: 'not-run', reason: 'Total delivery budget exceeded' }; continue }
      const row = report.steps[id] = { status: 'running', phase: s.phase ?? 'acceptance', startedAt: new Date().toISOString() }
      const deadline = Date.now() + (s.timeoutMs ?? 30 * 60 * 1000)
      const remaining = () => Math.min(deadline - Date.now(), budget - (Date.now() - t0))
      const assertActive = () => {
        assertDeliveryActive()
        if (Date.now() >= deadline) throw Error(`${id}: step budget exceeded`)
      }
      const identity = () => observeIdentity(root, s, identify, { outDir, signal: controller.signal, timeoutMs: remaining() })
      await save(); emit({ kind: 'step', id, state: 'run' })
      // Heartbeats update a separate file to avoid racing report snapshots.
      beat = setInterval(() => { atomicJson(join(home, 'heartbeat.json'), { runId, pid: process.pid, step: id, at: new Date().toISOString() }).catch(() => {}) }, 15000)
      try {
        await assertSourceUnchanged()
        assertActive()
        // A build-type step keys on buildInputs only; every other step keys on build + test inputs.
        const buildScoped = rules.testInputs.length > 0 && s.scope !== 'all' && (s.phase === 'build' || s.scope === 'build')
        const key = await inputFingerprint(root, s.inputs ?? ['**'], { step: s, deps: (s.after ?? []).map(d => keys[d]), runtime: process.version, context: config.context ?? {}, ...(rules.testInputs.length ? { inputRules: rules } : {}) },
          buildScoped ? f => inputClass(f, rules) === 'build' : undefined)
        const cacheFile = join(cacheDir, digest(id) + '.json')
        const cached = await readFile(cacheFile, 'utf8').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null })
        // Reuse needs a pin: output bytes and/or an observed artifact identity. No pin, no reuse.
        const pinned = !!(s.outputs?.length || s.identity?.length)
        const reusable = plan.mode !== 'full' && s.reuse === true && !s.mutates && s.phase !== 'preflight' && pinned && cached?.key === key && cached?.status === 'pass'
        let reused = false, outputHash = null, artifactId = null
        if (reusable) {
          // Every declared pin must be re-observed and equal to the receipt; anything unverifiable rebuilds.
          try {
            reused = true
            if (s.outputs?.length) { outputHash = await hashPaths(root, s.outputs, { required: true }); reused = outputHash === cached.outputHash }
            if (reused && s.identity?.length) { artifactId = await identity(); reused = artifactId === cached.artifactId }
          } catch { reused = false /* missing artifacts / unreachable probe must be rebuilt */ }
          if (!reused) { outputHash = null; artifactId = null }
          // A failed/mismatching probe may also have overlapped a source edit.
          // That is not permission to build against the already-computed key.
          assertActive()
          await assertSourceUnchanged()
          assertActive()
        }
        if (!reused) {
          assertActive()
          const result = await run(s, { root, outDir, report, signal:controller.signal, timeoutMs: remaining(), emit })
          assertActive()
          if (result?.ok !== true) throw Error(`${id} produced no affirmative execution evidence`)
          await assertSourceUnchanged()
          if (s.outputs?.length) outputHash = await hashPaths(root, s.outputs, { required: true })
          if (s.identity?.length) artifactId = await identity()
          row.evidence = result
        }
        // Both fresh execution and reuse converge here AFTER every output/identity
        // observation. Only stable observations may publish a receipt or a pass.
        await assertSourceUnchanged()
        assertActive()
        if (!reused && s.reuse === true && pinned && !s.mutates) await atomicJson(cacheFile, { key, outputHash, ...(artifactId ? { artifactId } : {}), status: 'pass', runId })
        Object.assign(row, { status: 'pass', execution: reused ? 'reused' : 'ran', ...(reused ? { fromRun: cached.runId } : {}), key, outputHash, ...(artifactId ? { artifact: artifactId } : {}), ...(rules.testInputs.length ? { scope: buildScoped ? 'build' : 'all' } : {}) })
        keys[id] = s.phase === 'preflight' ? digest(json(s)) : digest(key + (outputHash ?? '') + (artifactId ?? ''))
      } catch (error) { Object.assign(row, { status: 'fail', reason: error.message }); emit({ kind: 'failure', id, reason: error.message }) }
      finally { clearInterval(beat); row.finishedAt = new Date().toISOString(); statuses[id] = row; await save() }
    }
    const outcome = planOutcome(steps, statuses)
    report.outcome = outcome
    for (const { id, ...row } of outcome.items) if (!report.steps[id]) report.steps[id] = row
    const passed = steps.length > 0 && steps.every(s => report.steps[s.id].status === 'pass')
    if (passed) await assertSourceUnchanged()
    if (passed) assertDeliveryActive()
    report.status = passed ? 'passed' : 'failed'
    report.finishedAt = new Date().toISOString()
    if (report.status === 'passed' && config.recordBaseline !== false) await atomicJson(join(home, 'baseline.json'), { commit: git(root, ['rev-parse', 'HEAD']).trim(), runId, mode: report.mode })
    await save(); return report
  } catch (error) { report.status = 'failed'; report.error = error.message; report.finishedAt = new Date().toISOString(); await save(); return report }
  finally { clearInterval(beat); process.removeListener('SIGTERM',onTerm);process.removeListener('SIGINT',onInt);await rm(lock, { force: true }) }
}

/** A promotion must include the currently published source. Adapters supply
 * their source graph (for Git: merge-base --is-ancestor published candidate).
 * Check before expensive work and again immediately before mutating production.
 * Explicit rollback is a separate operation, never an implicit promotion. */
export async function assertPromotionLineage({ candidate, published, isAncestor }) {
  if (typeof candidate !== 'string' || !candidate.trim() || typeof published !== 'string' || !published.trim()) throw Error('Both candidate and published source identities are required')
  if (typeof isAncestor !== 'function') throw Error('A source ancestry verifier is required')
  if (await isAncestor(published, candidate) !== true) throw Error(`Candidate ${candidate} does not include published source ${published}; merge the live changes before promotion`)
  return { candidate, published, includesPublished: true }
}
