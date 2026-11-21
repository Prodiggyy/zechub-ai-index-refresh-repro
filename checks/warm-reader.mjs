import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
const data=await readFile(new URL('./inputs/vectorSearch.ts',import.meta.url));
const pinned='d3a2f32fdd2feb1904c17bbc03dcfba5bb0b03b3';
assert.equal(createHash('sha1').update('blob '+data.length+'\0').update(data).digest('hex'),pinned);
const source=stripTypeScriptTypes(data.toString().slice(data.toString().indexOf('const DEFAULT_TOP_K')).replace(/^export /gm, ''));
const fixture=new vm.Script(source+'\nsearchDocs;');
function row(id,index) {
  const embedding=Array(1536).fill(0); embedding[index]=1;
  return {id,embedding,metadata:{path:id+'.md'},content:id};
}
const old=row('old',0), revised=row('revised',0), unchanged=row('unchanged_other_topic',1);
let serving=[old]; let shouldFailRpc=false; let rpcCalls=0; let embeddingLoads=0; let directMatches=[];
const storage={
  from(name){assert.equal(name,'docs_embeddings');return {select(cols){
    if(cols==='id, embedding') return {range:async()=>{embeddingLoads++;return {data:serving,error:null};}};
    assert.equal(cols,'id, content, metadata');
    return {in:async (key,ids)=>{assert.equal(key,'id');const rows=serving.filter(r=>ids.includes(r.id));directMatches=rows.map(r=>r.id);return {data:rows,error:null};}};
  }};},
  async rpc(name){assert.equal(name,'match_docs_embeddings'); rpcCalls++;
    if(shouldFailRpc)return{data:null,error:{message:'simulated RPC failure'}};
    return {data:serving.filter(r=>r.embedding[0]===1).map(r=>({...r,similarity:1})),error:null};
  },
};
function freshWorker(){
  return fixture.runInNewContext({console:{log(){},warn(){},error(){}},URL,
    EMBEDDING_DIMENSIONS:1536,EMBEDDING_MODEL:'stub',hasOpenAIApiKey:()=>true,hasSupabaseEnv:()=>true,
    getSupabaseAdminClient:()=>storage,getOpenAIClient:()=>({embeddings:{create:async()=>({data:[{embedding:old.embedding}]})}})});
}
const results={}; async function run(key,reader){
 const before=rpcCalls; const value=await reader('topic');
 results[key]={directMatches,rpcCalls:rpcCalls-before,chunks:Array.from(value.chunks,x=>x.id),searchAvailable:value.searchAvailable,outOfScope:value.outOfScope,totalEmbeddingLoads:embeddingLoads};
}
let reader=freshWorker();
await run('oldGeneration',reader);
serving=[revised]; await run('wholeGenerationReplaced',reader);
await run('sameWarmWorkerSecondRequest',reader);
shouldFailRpc=true;await run('wholeGenerationReplacedFallbackFails',reader);shouldFailRpc=false;
await run('newWorkerAfterReplacement',freshWorker());
serving=[old,unchanged];reader=freshWorker();await run('beforePartialUpdate',reader);
serving=[revised,unchanged];await run('partialUpdateWhileWarm',reader);
await run('newWorkerAfterPartialUpdate',freshWorker());
assert.deepEqual(results.wholeGenerationReplaced.directMatches,[]);
assert.deepEqual(results.wholeGenerationReplaced.chunks,['revised']);
assert.equal(results.wholeGenerationReplaced.rpcCalls,1);
assert.equal(results.sameWarmWorkerSecondRequest.rpcCalls,1);
assert.deepEqual(results.wholeGenerationReplacedFallbackFails.chunks,[]);
assert.equal(results.wholeGenerationReplacedFallbackFails.searchAvailable,null);
assert.deepEqual(results.newWorkerAfterReplacement.chunks,['revised']);
assert.equal(results.newWorkerAfterReplacement.rpcCalls,0);
assert.deepEqual(results.partialUpdateWhileWarm.chunks,[]);
assert.equal(results.partialUpdateWhileWarm.outOfScope,true);
assert.equal(results.partialUpdateWhileWarm.rpcCalls,0);
assert.equal(results.newWorkerAfterPartialUpdate.chunks[0],'revised');
console.log(JSON.stringify({repo:'ZecHub/zechub-wiki@a4412eb10207d5e69397367a38384d0414700cb5',path:'src/lib/ai/vectorSearch.ts',blob:pinned,scope:'Actual reader and cosine logic, synthetic orthogonal 1536-dimensional vectors; mock Supabase row service and RPC. Neither deployed service nor actual vector index was queried.',results},null,2));
