import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRetained } from '../src/artifacts.mjs'
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
