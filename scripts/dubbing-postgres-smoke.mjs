import assert from 'node:assert/strict';
import { startHarness } from './harness.mjs';
process.env.HUB_TEST_DOCKER_IMAGE ||= 'merchant-content-hub:local';
const env = await startHarness({ seed: false, auth: true, asrEnvironment: { TTS_WORKER_ENABLED: 'false', ASR_WORKER_ENABLED: 'false' } });
try {
  const result = await env.apiCommand(`
    import assert from 'node:assert/strict';
    import {execFileSync} from 'node:child_process';
    import {readFileSync} from 'node:fs';
    import {randomUUID} from 'node:crypto';
    process.env.TTS_API_KEY='pg-test-only'; process.env.TTS_BASE_URL='http://127.0.0.1:45678/api/v1'; process.env.TTS_MODEL='cosyvoice-v3-flash';
    const store=await import('./dist/api/server/db.js'),svc=await import('./dist/api/server/service.js'),work=await import('./dist/api/server/dubbing.js');
    execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=6','/tmp/voice.wav']);
    execFileSync('ffmpeg',['-v','error','-y','-i','/tmp/voice.wav','/tmp/speech.mp3']);
    let creates=0,syntheses=0;
    globalThis.fetch=async(url,options)=>{
      if(String(url).endsWith('/result.mp3'))return new Response(readFileSync('/tmp/speech.mp3'));
      const data=JSON.parse(options.body);
      if(data.input.action==='create_voice'){creates++;return Response.json({output:{voice_id:'cosyvoice-v3-flash-fieldwork-pg'}});}
      if(data.input.action==='query_voice')return Response.json({output:{status:'OK',target_model:'cosyvoice-v3-flash'}});
      syntheses++;assert.equal(data.input.pitch,1.1);assert.equal(data.input.instruction,data.input.text==='第二句轻松慢读。'?'用日常聊天的语调，表达自然流畅。情绪轻松自然，表达舒展。':'用日常聊天的语调，表达自然流畅。语气温暖亲切。');return Response.json({output:{audio:{url:'http://127.0.0.1:45678/result.mp3'}}});
    };
    const form=new FormData();form.set('requestId',randomUUID());form.set('name','保存到 PostgreSQL 的音色');form.set('consent','true');form.set('file',new File([readFileSync('/tmp/voice.wav')],'sample.wav'));
    const voice=await work.createVoice(form);await work.processNextDubbing();assert.equal((await store.get('voices',voice.id)).status,'ready');
    const payload={requestId:randomUUID(),title:'PostgreSQL 配音',voiceId:voice.id,text:'你好。Hello from PostgreSQL.',rate:1,pitch:1.1,tone:'conversational',emotion:'warm'};
    const[a,b]=await Promise.all([work.enqueueDubbing(payload),work.enqueueDubbing(payload)]);assert.equal(a.id,b.id);
    await Promise.all([work.processNextDubbing(),work.processNextDubbing()]);
    const saved=await store.get('dubbings',a.id);assert.equal(saved.status,'completed');assert.equal(creates,1);assert.equal(syntheses,1);
    assert.equal(saved.text,payload.text); for(const t of ['merchants','projects','assets'])assert.equal((await store.all(t)).length,0);
    const parts=[{id:randomUUID(),text:'第一句保留全篇表达。'},{id:randomUUID(),text:'第二句轻松慢读。',settings:{emotion:'relaxed',rate:0.85},pauseAfterMs:500}];
    const segmentedPayload={...payload,requestId:randomUUID(),title:'PostgreSQL 逐句配音',text:parts.map(p=>p.text).join('\\n'),parts};
    const segmented=await work.enqueueDubbing(segmentedPayload);
    assert.equal((await work.enqueueDubbing(segmentedPayload)).id,segmented.id);
    await work.processNextDubbing();assert.equal((await store.get('dubbings',segmented.id)).status,'completed');assert.equal(syntheses,3);
    await work.deleteVoice(voice.id);assert.equal((await work.dubbingSnapshot()).voices[0].status,'deleting');
    console.log(JSON.stringify({voiceId:voice.id,jobId:a.id,segmentedJobId:segmented.id,assetId:saved.output.id,creates,syntheses}));await store.db.close();
  `);
  const ids = JSON.parse(result.split('\n').at(-1));
  await env.recreate();
  const headers = { Authorization: 'Bearer ' + env.token };
  const snapshot = await fetch(env.base + '/api/dubbing-workspace', { headers }).then(r => r.json());
  assert.equal(snapshot.voices.find(v => v.id === ids.voiceId).status, 'deleting');
  assert.equal(snapshot.dubbings.find(d => d.id === ids.jobId).hasAudio, true);
  const stored = snapshot.dubbings.find(d => d.id === ids.jobId); assert.equal(stored.tone, 'conversational'); assert.equal(stored.emotion, 'warm'); assert.equal(stored.pitch, 1.1);
  const segmented = snapshot.dubbings.find(d => d.id === ids.segmentedJobId); assert.equal(segmented.parts.length, 2); assert.equal(segmented.parts[1].settings.rate, 0.85); assert.equal(segmented.parts[1].settings.emotion, 'relaxed'); assert.equal(segmented.parts[1].pauseAfterMs, 500); assert.equal(segmented.completedParts, 2); assert.ok(!('clipResults' in segmented));
  assert.ok(!('providerVoiceId' in snapshot.voices[0])); assert.ok(!('audioUrl' in snapshot.dubbings[0]));
  const audio = await fetch(env.base + '/api/dubbing-files/' + ids.jobId, { headers: { ...headers, Range: 'bytes=0-31' } }); assert.equal(audio.status, 206); assert.equal((await audio.arrayBuffer()).byteLength, 32);
  assert.equal((await fetch(env.base + '/api/dubbing-files/' + ids.jobId)).status, 401);
  const deleted = await env.apiCommand(`
    import assert from 'node:assert/strict';process.env.TTS_API_KEY='pg-test-only';process.env.TTS_BASE_URL='http://127.0.0.1:45678/api/v1';process.env.TTS_MODEL='cosyvoice-v3-flash';
    const store=await import('./dist/api/server/db.js'),work=await import('./dist/api/server/dubbing.js');let deletes=0;
    globalThis.fetch=async(url,options)=>{const data=JSON.parse(options.body);assert.equal(data.input.action,'delete_voice');deletes++;return Response.json({output:{}});};
    await work.processNextDubbing();assert.equal((await store.all('voices')).length,0);assert.equal(deletes,1);assert.equal((await store.all('dubbings')).filter(d=>d.status==='completed').length,2);
    console.log('deleted');await store.db.close();
  `);
  assert.match(deleted, /deleted/);
  assert.equal((await fetch(env.base + '/api/dubbing-files/' + ids.voiceId + '?sample', { headers })).status, 404);
  assert.equal((await fetch(env.base + '/api/dubbing-files/' + ids.jobId, { headers })).status, 200);
  console.log(JSON.stringify({ postgres: true, voiceSaved: true, expressionSettingsPreserved: true, sentenceSettingsPreserved: true, jsonbIdempotency: true, idempotentSynthesis: true, containerRecreationPersistence: true, voiceDeletionResumesAfterRecreation: true, completedAudioSurvivesDeletion: true, audioRange: true, protectedDownload: true, realModelCalls: false }));
} finally { await env.stop(); }
