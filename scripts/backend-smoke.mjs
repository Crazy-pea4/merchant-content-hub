import assert from 'node:assert/strict';
import { startHarness } from './harness.mjs';
process.env.HUB_TEST_DOCKER_IMAGE ||= 'merchant-content-hub:local';
const env = await startHarness({ seed:false, auth:true, asrEnvironment:{ ASR_WORKER_ENABLED:'false', HUB_ALLOWED_ORIGINS:'https://mobile.example.test' } });
let checks=0;
const api=async(path,method='GET',body,headers={})=>{const r=await fetch(env.apiBase+'/api/'+path,{method,headers:{Authorization:'Bearer '+env.token,...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json(),headers:r.headers};};
try {
  const imported=await env.apiCommand(`
    import assert from 'node:assert/strict';import{DatabaseSync}from'node:sqlite';import{createHash}from'node:crypto';
    const path='/tmp/legacy-fixture.sqlite',source=new DatabaseSync(path),createdAt=new Date().toISOString();
    const segments=[{start:0.4,end:3.2,text:'三轮车锂电池选购',words:[{start:0.4,end:1.2,text:'三轮车'},{start:1.2,end:3.2,text:'锂电池选购'}],speakerId:0}];
    const asset={id:'legacy-asset',projectId:'legacy-project',name:'旧视频.mp4',kind:'video',mime:'video/mp4',size:0,storageKey:'legacy.mp4',thumbnailKey:null,duration:4,tags:['锂电池'],segments,transcriptSource:'asr',rights:'authorized',expiresAt:'',note:'旧素材',error:null,createdAt};
    const fingerprint=createHash('sha256').update(JSON.stringify([asset.storageKey,segments])).digest('hex');
    const values={merchants:[{id:'legacy-merchant',name:'迁移商家',industry:'锂电池',city:'待确认',createdAt}],projects:[{id:'legacy-project',merchantId:'legacy-merchant',name:'迁移项目',mode:'shoot',goal:'锂电池科普',fee:0,dueDate:'',deliverables:1,createdAt}],assets:[asset],contents:[{id:'legacy-content',projectId:'legacy-project',title:'已审核版本',platform:'抖音',script:'旧脚本',caption:'旧文案',brief:'',hashtags:[],sourceAssetIds:[asset.id],mediaAssetId:null,provider:'api',status:'approved',version:2,reviews:[{id:'old-review',action:'approve',version:2,author:'客户',at:createdAt,comment:'确认'}],reviewToken:'a'.repeat(48),reviewExpiresAt:new Date(Date.now()+3600000).toISOString(),scheduledAt:null,createdAt}],tasks:[{id:'legacy-task',projectId:'legacy-project',title:'旧任务',description:'核对字幕',owner:'待分配',status:'todo',priority:'high',dueDate:'',createdAt}],activities:[{id:'legacy-event',projectId:'legacy-project',text:'原始日志',at:createdAt}],asr_jobs:[{id:asset.id,projectId:asset.projectId,taskId:'keep-remote-task',baseUrl:'https://dashscope.aliyuncs.com/api/v1',model:'qwen-audio-3.1-asr-flash-filetrans',fingerprint,createdAt}],transcription_jobs:[{id:asset.id,projectId:asset.projectId,status:'completed',fingerprint,createdAt,updatedAt:createdAt,runAt:0,leaseUntil:0,leaseToken:null,attempts:1,failures:0,error:null,submissionStarted:true}]};
    for(const[table,rows]of Object.entries(values)){source.exec('CREATE TABLE '+table+'(data TEXT NOT NULL)');const put=source.prepare('INSERT INTO '+table+'(data) VALUES(?)');for(const row of rows)put.run(JSON.stringify(row));}source.close();
    process.env.LEGACY_SQLITE_PATH=path;const store=await import('./dist/api/server/db.js');await store.databaseReady;
    for(const[table,rows]of Object.entries(values)){const saved=await store.all(table);assert.equal(saved.length,rows.length);for(const row of rows){const actual=await store.get(table,row.id);if('fingerprint'in row){assert.equal(actual.taskId??'keep-remote-task','keep-remote-task');assert.notEqual(actual.fingerprint,row.fingerprint);delete actual.fingerprint;delete row.fingerprint;}assert.deepEqual(actual,row);}}
    const normalized=await store.get('assets',asset.id);assert.equal(normalized.segments[0].words.length,2);
    await assert.rejects(()=>store.transaction(async()=>{await store.put('merchants',{...values.merchants[0],name:'不得保存'});throw Error('rollback');}));assert.equal((await store.get('merchants','legacy-merchant')).name,'迁移商家');
    console.log(JSON.stringify({tablesImported:8,idsAndPayloadsPreserved:true,wordsPreserved:true,remoteTaskIdPreserved:true,transactionRollback:true}));await store.db.close();
  `);
  assert.equal(JSON.parse(imported.split('\n').at(-1)).tablesImported,8);checks++;
  assert.equal(await env.databaseQuery("SELECT count(*) FROM hub_migrations WHERE name='sqlite-v3-import'"),'1');
  await env.apiCommand("process.env.LEGACY_SQLITE_PATH='/tmp/legacy-fixture.sqlite';const store=await import('./dist/api/server/db.js');await store.databaseReady;if((await store.all('assets')).length!==1)throw Error('duplicate import');await store.db.close();");checks++;
  await env.apiCommand(`
    import assert from 'node:assert/strict';
    const store=await import('./dist/api/server/db.js'),queue=await import('./dist/api/server/transcription-queue.js');
    const job={...await store.get('transcription_jobs','legacy-asset'),status:'processing',leaseToken:'concurrent-lease',leaseUntil:Date.now()+30000,submissionStarted:false};
    await store.put('transcription_jobs',job);
    await Promise.all([queue.updateClaim(job,{submissionStarted:true}),queue.updateClaim(job,{leaseUntil:Date.now()+60000})]);
    const saved=await store.get('transcription_jobs',job.id);assert.equal(saved.submissionStarted,true);assert.ok(saved.leaseUntil>job.leaseUntil);
    await queue.updateClaim(job,{status:'completed',leaseToken:null,leaseUntil:0});await store.db.close();
  `);checks++;
  console.log('PASS PostgreSQL 真实导入8类SQLite记录，保留ID/审核令牌/词级时间/远端任务；重复启动不重复导入，事务回滚有效');
  assert.equal((await api('health')).data.backend,'fastify');assert.match((await api('snapshot')).data.capabilities.storage,/PostgreSQL/);checks++;
  assert.equal((await fetch(env.apiBase+'/api/snapshot')).status,401);checks++;
  const preflight=await fetch(env.apiBase+'/api/snapshot',{method:'OPTIONS',headers:{Origin:'https://mobile.example.test','Access-Control-Request-Method':'GET'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'https://mobile.example.test');checks++;
  assert.equal((await fetch(env.apiBase+'/api/snapshot',{method:'OPTIONS',headers:{Origin:'https://other.example.test'}})).status,403);checks++;
  assert.equal((await api('merchants','POST',{name:'不可写入'},{Origin:'https://other.example.test'})).status,403);checks++;
  const merchant=await api('merchants','POST',{name:'安卓接口验收',industry:'测试',city:'测试'});assert.equal(merchant.status,201);const project=await api('projects','POST',{merchantId:merchant.data.id,name:'原生客户端项目',mode:'shoot',dueDate:'',deliverables:1});assert.equal(project.status,201);checks++;
  console.log('PASS 独立Fastify端口可供无Origin的Bearer客户端使用；Cookie/CORS来源采取精确白名单');
  const form=new FormData();form.set('projectId',project.data.id);form.set('rights','authorized');form.set('file',new File(['用于测试审核并发的真实文稿'],'并发文稿.txt'));const uploaded=await fetch(env.base+'/api/assets',{method:'POST',headers:{Authorization:'Bearer '+env.token,Origin:env.base},body:form});assert.equal(uploaded.status,201);const asset=await uploaded.json();checks++;
  const generated=await api('generate','POST',{projectId:project.data.id,platform:'抖音',referenceMode:'manual',referenceAssetIds:[asset.id]});assert.equal(generated.status,201);assert.equal(generated.data.provider,'demo');const content=generated.data.contents[0];checks++;
  await api('contents/'+content.id+'/transition','POST',{action:'submit',version:1});
  const concurrent=await Promise.all([api('contents/'+content.id+'/transition','POST',{action:'approve',version:1}),api('contents/'+content.id+'/transition','POST',{action:'approve',version:1})]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);checks++;
  const oversized=await fetch(env.base+'/api/merchants',{method:'POST',headers:{Authorization:'Bearer '+env.token,Origin:env.base,'Content-Type':'application/json'},body:JSON.stringify({name:'x'.repeat(210000)})});assert.equal(oversized.status,413);checks++;
  console.log('PASS 网页代理保留multipart与鉴权，大JSON受限；PostgreSQL并发审核只允许一个成功');
  await env.stopApi();const unavailable=await fetch(env.base+'/api/snapshot',{headers:{Authorization:'Bearer '+env.token}});assert.equal(unavailable.status,502);assert.match((await unavailable.json()).error,/后端服务/);checks++;
  console.log('PASS Fastify停止后网页返回502，不会读取另一份本地业务数据库');
  console.log('Backend smoke passed: '+checks+' checks; real PostgreSQL, isolated data, no billable model calls.');
}finally{await env.stop();}
