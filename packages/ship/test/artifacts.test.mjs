import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRetained } from '../src/artifacts.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

test('direct archive storage remains retainable when the local image catalog is garbage-collected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeubi-archive-'))
  try {
    const archive = path.join(root, 'candidate.tar'), catalog = path.join(root, 'image-tag')
    let builds = 0
    const result = await buildRetained({
      build: async () => { builds++; await fs.writeFile(archive, 'sealed exported bytes'); await fs.writeFile(catalog, 'tag'); await fs.rm(catalog) },
      inspect: async () => ({ id: createHash('sha256').update(await fs.readFile(archive)).digest('hex') }),
      retain: async artifact => ({ id: archive, artifactId: createHash('sha256').update(await fs.readFile(archive)).digest('hex') }),
      attempts: 1,
    })
    assert.equal(builds, 1); assert.equal(result.lease.artifactId, result.artifact.id)
    await assert.rejects(fs.access(catalog)); assert.equal(await fs.readFile(result.lease.id, 'utf8'), 'sealed exported bytes')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('repeated image disappearance stops at the declared retry bound', async () => {
  let builds = 0
  await assert.rejects(buildRetained({ build: async () => { builds++ }, inspect: async () => { throw Error('missing') }, retain: async () => {}, missing: () => true, attempts: 2 }), /missing/)
  assert.equal(builds, 2)
})
test('artifact removed after successful build retries only cached build and holds exact identity', async () => {
  let built=0, inspections=0
  const r=await buildRetained({build:async()=>{built++},inspect:async()=>{if(!inspections++)throw Object.assign(Error('GC removed artifact'),{code:'MISSING'});return{id:'sha:real'}},retain:async a=>({id:'lease',artifactId:a.id}),missing:e=>e.code==='MISSING'})
  assert.equal(built,2);assert.equal(r.lease.artifactId,'sha:real')
})
test('build failure, unknown storage error and wrong retained artifact never become pass', async()=>{
  let builds=0
  await assert.rejects(buildRetained({build:async()=>{builds++;throw Error('compile failed')},missing:()=>true}),/compile failed/)
  assert.equal(builds,1)
  await assert.rejects(buildRetained({build:async()=>{},inspect:async()=>({id:'new'}),retain:async()=>({id:'hold',artifactId:'old'})}),/exact artifact/)
  await assert.rejects(buildRetained({build:async()=>{},inspect:async()=>{throw Error('permission denied')},missing:()=>false}),/permission/)
})
