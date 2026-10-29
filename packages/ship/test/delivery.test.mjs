import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { deliver, checklist, deliveryMode } from '../src/delivery.mjs'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ubi-delivery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'engine')); await mkdir(join(root, 'web'))
  await writeFile(join(root, '.gitignore'), '.vibeubi/\ndist/\n')
  await writeFile(join(root, 'web/a.js'), 'web-v1'); await writeFile(join(root, 'engine/a.js'), 'engine-v1')
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim()
  git(['init']); git(['add', '.']); git(['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'initial'])
  const config = { features: [
    { id: 'web', covers: ['web/**'], steps: ['web-build', 'web-test'] },
    { id: 'engine', covers: ['engine/**'], steps: ['engine-build', 'engine-test'] },
    { id: 'delivery', covers: ['.gitignore'], steps: ['preflight'] },
  ], steps: [
    { id: 'preflight', phase: 'preflight', always: true },
    { id: 'verify', fullOnly: true },
    ...['web', 'engine'].flatMap(id => [
      { id: id + '-build', phase: 'build', inputs: [id + '/**'], outputs: ['dist/' + id], reuse: true, after: ['preflight'] },
      { id: id + '-test', phase: 'acceptance', after: [id + '-build'] },
    ])
  ] }
  const calls = []
  const execute = async s => {
    calls.push(s.id)
    if (s.outputs) { await mkdir(join(root, 'dist'), { recursive: true }); await writeFile(join(root, s.outputs[0]), await readFile(join(root, s.id.split('-')[0] + '/a.js'))) }
    return { ok: true }
  }
  return { root, config, calls, execute, changed: ['web/a.js', 'engine/a.js', '.gitignore'], baseline: git(['rev-parse', 'HEAD']) }
}
test('ordinary web AND engine changes start at build; full only explicit or declared major', async t => {
  const f = await fixture(t)
  let r = await deliver(f)
  assert.equal(r.status, 'passed'); assert.equal(r.mode, 'incremental'); assert.ok(!f.calls.includes('verify'))
  f.calls.length = 0
  r = await deliver({ ...f, changed: ['engine/a.js'] })
  assert.equal(r.status, 'passed'); assert.ok(f.calls.includes('engine-test')); assert.ok(!f.calls.includes('web-test')); assert.ok(!f.calls.includes('verify'))
  for (const opts of [{ full: true }, { major: 'Storage schema migration' }]) {
    f.calls.length = 0; r = await deliver({ ...f, ...opts })
    assert.equal(r.mode, 'full'); assert.ok(f.calls.includes('verify')); assert.ok(f.calls.includes('web-build'))
  }
  assert.equal(deliveryMode({}).mode, 'incremental')
})
test('dependency fingerprints reuse unchanged build, changed bytes/missing output rebuild it', async t => {
  const f = await fixture(t); const opts = { ...f, changed: ['web/a.js'] }
  await deliver(opts); f.calls.length = 0
  let r = await deliver(opts)
  assert.equal(r.steps['web-build'].execution, 'reused'); assert.ok(!f.calls.includes('web-build')); assert.ok(f.calls.includes('web-test'))
  await writeFile(join(f.root, 'engine/a.js'), 'unrelated-engine-change')
  r = await deliver(opts); assert.equal(r.steps['web-build'].execution, 'reused')
  await writeFile(join(f.root, 'web/a.js'), 'changed-web')
  r = await deliver(opts); assert.equal(r.steps['web-build'].execution, 'ran')
  await writeFile(join(f.root, 'dist/web'), 'corrupt')
  r = await deliver(opts); assert.equal(r.steps['web-build'].execution, 'ran')
  await rm(join(f.root, 'dist/web'))
  r = await deliver(opts); assert.equal(r.steps['web-build'].execution, 'ran')
})
test('preflight collects independent failures before expensive work and checkpoints each failure', async t => {
  const f = await fixture(t)
  f.config.steps.unshift({ id: 'ssh', phase: 'preflight', always: true })
  const r = await deliver({ ...f, execute: async s => {
    if (s.id === 'preflight') {
      const saved = JSON.parse(await readFile(join(f.root, '.vibeubi/delivery/status.json')))
      assert.equal(saved.steps.ssh.status, 'fail')
    }
    f.calls.push(s.id); throw Error('unavailable ' + s.id)
  } })
  assert.deepEqual(f.calls, ['ssh', 'preflight']); assert.equal(r.status, 'failed')
  assert.equal(r.steps['web-build'].status, 'blocked')
})
test('one failed test does not stop independent tests; resume does not repeat successful build', async t => {
  const f = await fixture(t)
  const r = await deliver({ ...f, execute: s => { if (s.id === 'web-test') throw Error('broken web'); return f.execute(s) } })
  assert.equal(r.status, 'failed'); assert.ok(f.calls.includes('engine-test'))
  f.calls.length = 0; const next = await deliver(f)
  assert.equal(next.status, 'passed'); assert.ok(!f.calls.includes('web-build')); assert.ok(f.calls.includes('web-test'))
})
test('new feature paths appear uncovered and cannot silently ship until declared', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'new-feature.js'), 'new')
  const p = await checklist({ ...f, changed: undefined }); assert.deepEqual(p.uncovered, ['new-feature.js'])
  const r = await deliver({ ...f, changed: undefined }); assert.equal(r.status, 'failed'); assert.equal(f.calls.length, 0)
  f.config.features.push({ id: 'new-feature', covers: ['new-feature.js'], steps: ['web-build', 'web-test'] })
  assert.equal((await deliver(f)).status, 'passed')
})
test('changed command/inputs invalidates cached evidence; source drift fails before downstream work', async t => {
  const f = await fixture(t); await deliver(f)
  f.config.steps.find(s => s.id === 'web-build').cmd = ['new-compiler']
  assert.equal((await deliver(f)).steps['web-build'].execution, 'ran')
  const r = await deliver({ ...f, execute: async s => { if (s.id === 'preflight') await writeFile(join(f.root, 'web/a.js'), 'during-run'); return f.execute(s) } })
  assert.equal(r.status, 'failed'); assert.equal(r.steps.preflight.status, 'fail')
})
test('real CLI ship uses delivery declaration and persists status; never invokes full verify by default', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'vibeubi.config.mjs'), `export default {delivery: {features:[{id:'app',covers:['**'],steps:['build','accept']}],steps:[{id:'full-verify',fullOnly:true,cmd:['${process.execPath}','-e','process.exit(17)']},{id:'build',cmd:['${process.execPath}','-e','console.log("built")']},{id:'accept',after:['build'],cmd:['${process.execPath}','--test','--test-reporter=tap','test.mjs'],expectsTests:true}]}}`)
  await writeFile(join(f.root, 'test.mjs'), "import test from 'node:test'; test('actual',()=>{})")
  const cli = new URL('../../../bin/vibeubi.mjs', import.meta.url).pathname.replace('/packages/bin/', '/bin/')
  try { execFileSync(process.execPath, [cli, 'ship', '--root', f.root], { stdio: 'pipe' }) } catch (e) { throw Error(e.stdout?.toString() + e.stderr?.toString()) }
  let r = JSON.parse(await readFile(join(f.root, '.vibeubi/delivery/status.json')))
  assert.equal(r.status, 'passed'); assert.equal(r.steps['full-verify'], undefined)
  assert.throws(() => execFileSync(process.execPath, [cli, 'ship', '--root', f.root, '--full'], { stdio: 'pipe' }))
  r = JSON.parse(await readFile(join(f.root, '.vibeubi/delivery/status.json')))
  assert.equal(r.steps['full-verify'].status, 'fail')
})
test('artifact input exclusions do not invalidate unrelated builds', async t => {
 const f=await fixture(t); f.config.steps.find(s=>s.id==='web-build').inputs=['**','!engine/**'];
 await deliver(f);await writeFile(join(f.root,'engine/a.js'),'new engine');
 const r=await deliver(f);assert.equal(r.steps['web-build'].execution,'reused');assert.equal(r.steps['engine-build'].execution,'ran');
})

test('interrupt records failure, kills its active command and never continues promotion', async t => {
 const f=await fixture(t)
 const payload=`require('fs').writeFileSync('.vibeubi/worker.pid',String(process.pid));setInterval(()=>{},1000)`
 await writeFile(join(f.root,'vibeubi.config.mjs'),`export default {delivery:{features:[{id:'app',covers:['**'],steps:['build','promote']}],steps:[{id:'build',cmd:${JSON.stringify([process.execPath,'-e',payload])}},{id:'promote',after:['build'],mutates:true,cmd:${JSON.stringify([process.execPath,'-e','process.exit(0)'])}}]}}`)
 const cli=new URL('../../../bin/vibeubi.mjs',import.meta.url).pathname.replace('/packages/bin/','/bin/')
 const child=spawn(process.execPath,[cli,'ship','--root',f.root],{stdio:'ignore'})
 const exited=new Promise(resolve=>child.on('exit',resolve))
 let pid
 for(let i=0;i<200;i++){try{pid=Number(await readFile(join(f.root,'.vibeubi/worker.pid'),'utf8'));break}catch{}await new Promise(r=>setTimeout(r,25))}
 assert.ok(pid);child.kill('SIGTERM');assert.equal(await exited,1)
 const r=JSON.parse(await readFile(join(f.root,'.vibeubi/delivery/status.json')))
 assert.equal(r.status,'failed');assert.equal(r.interruptedBy,'SIGTERM');assert.equal(r.steps.promote.status,'blocked')
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
 const list=JSON.parse(await readFile(join(f.root,'.vibeubi/checklist.json')))
 assert.equal(list.status,'failed');assert.equal(list.features[0].status,'fail')
})

test('build-only runs cannot advance the deployed change baseline',async t=>{
 const f=await fixture(t);f.config.recordBaseline=false;
 assert.equal((await deliver(f)).status,'passed');
 await assert.rejects(readFile(join(f.root,'.vibeubi/delivery/baseline.json')),{code:'ENOENT'});
})

test('explicit feature exclusions remain visible and never inherit another feature pass; full overrides scope',async t=>{
 const f=await fixture(t);f.config.features.find(f=>f.id==='engine').excludedReason='Owner explicitly limited this release to web';
 const r=await deliver(f);assert.equal(r.status,'passed');assert.ok(!f.calls.includes('engine-test'));
 assert.equal(r.plan.features.find(f=>f.id==='engine').status,'excluded');
 f.calls.length=0;await deliver({...f,full:true});assert.ok(f.calls.includes('engine-test'));
})
