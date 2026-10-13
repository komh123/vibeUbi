import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,mkdir,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{execFileSync}from'node:child_process';import{inputFingerprint}from'../src/delivery.mjs';
test('conservative build inputs detect a new source root that a directory allowlist misses',async()=>{
 const root=await mkdtemp(join(tmpdir(),'vibeubi-input-'));try{
 execFileSync('git',['init'],{cwd:root,stdio:'ignore'});await mkdir(join(root,'app'));await writeFile(join(root,'app/index.js'),'app');
 const patterns=['**','!docs/**'];const before=await inputFingerprint(root,patterns),tooNarrow=await inputFingerprint(root,['app/**']);
 await mkdir(join(root,'new-feature'));await writeFile(join(root,'new-feature/data.json'),'{}');
 assert.notEqual(await inputFingerprint(root,patterns),before);assert.equal(await inputFingerprint(root,['app/**']),tooNarrow,'the wrong allowlist misses this source change');
 const changed=await inputFingerprint(root,patterns);await mkdir(join(root,'docs'));await writeFile(join(root,'docs/notes.md'),'documentation');assert.equal(await inputFingerprint(root,patterns),changed);
 }finally{await rm(root,{recursive:true,force:true})}
});
