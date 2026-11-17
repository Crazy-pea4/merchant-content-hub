import assert from 'node:assert/strict';
import { startHarness } from './harness.mjs';
process.env.HUB_TEST_DOCKER_IMAGE ||= 'merchant-content-hub:local';
const env = await startHarness({ seed: false, auth: true, asrEnvironment: { TTS_WORKER_ENABLED: 'false', ASR_WORKER_ENABLED: 'false', NARRATION_WORKER_ENABLED: 'false' } });
try {
  const output = await env.apiCommand(`
    import assert from 'node:assert/strict';import{execFileSync}from'node:child_process';import{readFileSync}from'node:fs';import{randomUUID}from'node:crypto';
    Object.assign(process.env,{AI_API_KEY:'narration-pg-only',AI_BASE_URL:'http://127.0.0.1:45678/translation/v1',AI_MODEL:'translate-pg',TTS_API_KEY:'narration-pg-only',TTS_BASE_URL:'http://127.0.0.1:45678/api/v1',TTS_MODEL:'cosyvoice-v3-flash',VISION_API_KEY:'narration-pg-only',VISION_BASE_URL:'http://127.0.0.1:45678/compatible-mode/v1',VISION_MODEL:'vision-pg'});
    const store=await import('./dist/api/server/db.js'),dubbing=await import('./dist/api/server/dubbing.js'),work=await import('./dist/api/server/narration.js'),preview=await import('./dist/api/server/dubbing-preview.js');
    execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=6','/tmp/voice.wav']);
    execFileSync('ffmpeg',['-v','error','-y','-i','/tmp/voice.wav','-t','3','/tmp/speech.mp3']);
    execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=red:s=320x180:r=12:d=6','-f','lavfi','-i','color=c=blue:s=320x180:r=12:d=6','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-c:v','libx264','-pix_fmt','yuv420p','/tmp/source.mp4']);
    let analyses=0,syntheses=0,translations=0;
    globalThis.fetch=async(url,options)=>{
      if(String(url).endsWith('/speech.mp3'))return new Response(readFileSync('/tmp/speech.mp3'));
      const b=JSON.parse(options.body);
      if(String(url).includes('/translation/v1/')){translations++;const c=JSON.parse(b.messages[1].content);return Response.json({choices:[{message:{content:JSON.stringify({segments:c.segments.map(s=>({id:s.id,lines:s.lines.map(line=>({index:line.index,text:'Quietly, at your own pace.'}))}))})}}]});}
      if(String(url).endsWith('/chat/completions')){analyses++;const c=JSON.parse(b.messages[1].content[0].text);return Response.json({choices:[{message:{content:JSON.stringify({title:'PostgreSQL视频旁白',summary:'两段画面',shots:c.shots.map((s,i)=>({id:s.id,description:'画面'+i})),segments:c.shots.map((s,i)=>({startShotId:s.id,endShotId:s.id,text:i?'慢一点。':'开始了。',tone:'storytelling',emotion:'warm',rate:1}))})}}]});}
      if(b.input.action==='create_voice')return Response.json({output:{voice_id:'cosyvoice-v3-flash-narration-pg'}});
      if(b.input.action==='query_voice')return Response.json({output:{status:'OK',target_model:'cosyvoice-v3-flash'}});
      syntheses++;return Response.json({output:{audio:{url:'http://127.0.0.1:45678/speech.mp3'}}});
    };
    const form=new FormData();form.set('requestId',randomUUID());form.set('name','PG测试音色');form.set('consent','true');form.set('file',new File([readFileSync('/tmp/voice.wav')],'voice.wav'));
    const voice=await dubbing.createVoice(form);await dubbing.processNextDubbing();
    const upload=new FormData();upload.set('requestId',randomUUID());upload.set('voiceId',voice.id);upload.set('subtitleMode','bilingual');upload.set('file',new File([readFileSync('/tmp/source.mp4')],'video.mp4'));
    const p=await work.uploadNarration(upload);await work.processNextNarration();const project=(await work.narrationSnapshot()).projects[0],s=project.segments[0];
    await preview.previewDubbing({requestId:randomUUID(),voiceId:voice.id,text:s.text,...s.settings,parts:[{id:s.id,text:s.text,settings:s.settings}],scope:'sentence',partId:s.id});assert.equal(syntheses,1);
    await work.processNextNarration();await work.processNextNarration();assert.equal((await store.get('narration_renders',p.id)).status,'completed');assert.equal(analyses,1);assert.equal(syntheses,2);assert.equal(translations,1);
    const edited=await work.saveNarration(p.id,{revision:project.revision,title:project.title,segments:project.segments.map((s,i)=>i?s:{...s,text:'新的一句。'})});
    const id=randomUUID(),payload={requestId:id,revision:edited.revision,voiceId:voice.id,originalVolume:0,subtitleMode:'bilingual'};await work.enqueueNarrationRender(p.id,payload);assert.equal((await work.enqueueNarrationRender(p.id,payload)).id,id);
    console.log(JSON.stringify({projectId:p.id,firstRender:p.id,queuedRender:id}));await store.db.close();
  `);
  const ids = JSON.parse(output.split('\n').at(-1)); await env.recreate();
  const headers = { Authorization: 'Bearer ' + env.token };
  const snapshot = await fetch(env.base + '/api/narration-workspace', { headers }).then(r => r.json());
  assert.equal(snapshot.projects[0].revision, 2); assert.equal(snapshot.renders.find(r => r.id === ids.queuedRender).status, 'queued'); assert.ok(!('clips' in snapshot.renders[0]));
  const resumed = await env.apiCommand(`
    import assert from 'node:assert/strict';import{execFileSync}from'node:child_process';import{readFileSync}from'node:fs';
    Object.assign(process.env,{AI_API_KEY:'narration-pg-only',AI_BASE_URL:'http://127.0.0.1:45678/translation/v1',AI_MODEL:'translate-pg',TTS_API_KEY:'narration-pg-only',TTS_BASE_URL:'http://127.0.0.1:45678/api/v1',TTS_MODEL:'cosyvoice-v3-flash'});
    const store=await import('./dist/api/server/db.js'),work=await import('./dist/api/server/narration.js');
    execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=3','/tmp/speech.mp3']);let calls=0,translations=0;
    globalThis.fetch=async(url,options)=>{if(String(url).endsWith('/speech.mp3'))return new Response(readFileSync('/tmp/speech.mp3'));const b=JSON.parse(options.body);if(String(url).includes('/translation/v1/')){translations++;const c=JSON.parse(b.messages[1].content);return Response.json({choices:[{message:{content:JSON.stringify({segments:c.segments.map(s=>({id:s.id,lines:s.lines.map(line=>({index:line.index,text:'A fresh start.'}))}))})}}]});}assert.equal(b.input.text,'新的一句。');calls++;return Response.json({output:{audio:{url:'http://127.0.0.1:45678/speech.mp3'}}});};
    await work.processNextNarration();assert.equal(calls,1);assert.equal(translations,1);assert.equal((await store.all('narration_renders')).filter(r=>r.status==='completed').length,2);
    const p=(await work.narrationSnapshot()).projects[0];assert.equal((await work.saveNarration(p.id,{revision:p.revision,title:p.title,segments:p.segments})).revision,p.revision);
    const edited=await work.saveNarration(p.id,{revision:p.revision,title:p.title,segments:p.segments.map((s,i)=>i?s:{...s,translation:{...s.translation,lines:s.translation.lines.map((line,j)=>j?line:{...line,text:'My editable English.'})}})});
    const id='0d84bf95-a4ab-4f19-8d75-1c9c72a3d9a9';await work.enqueueNarrationRender(p.id,{requestId:id,revision:edited.revision,voiceId:p.voiceId,subtitleMode:'bilingual'});await work.processNextNarration();assert.equal(calls,1);assert.equal(translations,1);
    const render=(await work.narrationSnapshot()).renders.find(r=>r.id===id);assert.equal(render.status,'completed');assert.ok(render.burnedCaptions&&render.hasCleanVideo);assert.equal(render.segments[0].translation.lines[0].text,'My editable English.');
    for(const t of ['merchants','projects','assets'])assert.equal((await store.all(t)).length,0);console.log('resumed');await store.db.close();
  `);
  assert.match(resumed, /resumed/);
  for (const id of [ids.firstRender, ids.queuedRender]) assert.equal((await fetch(env.base + '/api/narration-files/' + id, { headers })).status, 200);
  assert.equal((await fetch(env.base + '/api/narration-files/' + ids.queuedRender)).status, 401);
  console.log(JSON.stringify({ postgres: true, autoRender: true, jsonbPreviewReuse: true, idempotentRequests: true, recreationPersistence: true, persistedClipReuseAfterRestart: true, translationOnlyEditReuse: true, bilingualCaptions: true, oldExportsRetained: true, protectedDownloads: true, independentBusinessData: true, realModelCalls: false }));
} finally { await env.stop(); }
