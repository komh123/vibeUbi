import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPromotionLineage } from '../src/delivery.mjs'

test('promotion rejects a stale or parallel candidate and accepts a merged successor',async()=>{
 const ancestors=new Map([['base',new Set(['base'])],['mobile',new Set(['base','mobile'])],['delivery',new Set(['base','delivery'])],['merged',new Set(['base','mobile','delivery','merged'])]])
 const isAncestor=async(a,b)=>ancestors.get(b)?.has(a)===true
 await assert.rejects(assertPromotionLineage({candidate:'delivery',published:'mobile',isAncestor}),/merge the live changes/)
 await assert.rejects(assertPromotionLineage({candidate:'base',published:'mobile',isAncestor}))
 assert.equal((await assertPromotionLineage({candidate:'merged',published:'mobile',isAncestor})).includesPublished,true)
 assert.equal((await assertPromotionLineage({candidate:'merged',published:'delivery',isAncestor})).includesPublished,true)
})
test('unknown identity, unverifiable source, or a non-boolean verdict never authorize promotion',async()=>{
 await assert.rejects(assertPromotionLineage({candidate:'candidate',published:null,isAncestor:async()=>true}),/identities/)
 await assert.rejects(assertPromotionLineage({candidate:'candidate',published:'live',isAncestor:async()=>{throw Error('repository unavailable')}}),/repository unavailable/)
 await assert.rejects(assertPromotionLineage({candidate:'candidate',published:'live',isAncestor:async()=>1}),/does not include/)
})
