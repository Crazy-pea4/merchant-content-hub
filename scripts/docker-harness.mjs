import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const docker = async args => (await exec('docker', args, { timeout: 60000, maxBuffer: 2_000_000 })).stdout.trim();
export async function startDockerHarness({ seed = false, auth = true, asrEnvironment = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fieldwork-docker-qa-'));
  const name = 'fieldwork-qa-' + randomBytes(6).toString('hex'), apiName = name + '-api', dbName = name + '-db';
  const network = name + '-network', volume = name + '-data', pgVolume = name + '-postgres';
  const token = auth ? randomBytes(24).toString('hex') : '', password = randomBytes(20).toString('hex');
  let base = '', apiBase = '';
  async function stop() {
    for (const container of [name,apiName,dbName]) await docker(['rm','--force',container]).catch(() => {});
    for (const v of [volume,pgVolume]) await docker(['volume','rm',v]).catch(() => {});
    await docker(['network','rm',network]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
  async function ready(url, container) {
    for (let i=0;i<120;i++) {
      try { const response=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1000)});if(response.ok)return; }catch{}
      await pause(200);
    }
    throw new Error('QA readiness failed: '+await docker(['logs','--tail','25',container]));
  }
  async function readyDb() {
    for(let i=0;i<100;i++){try{await docker(['exec',dbName,'pg_isready','-h','127.0.0.1','-U','hub','-d','hub_test']);return;}catch{}await pause(200);}
    throw new Error('QA PostgreSQL readiness failed');
  }
  async function ports() {
    base='http://127.0.0.1:'+(await docker(['port',name,'3100/tcp'])).split(':').at(-1);
    apiBase='http://127.0.0.1:'+(await docker(['port',apiName,'3101/tcp'])).split(':').at(-1);
  }
  async function launch() {
    await docker(['run','--detach','--name',dbName,'--network',network,'--network-alias','postgres','--mount',`type=volume,src=${pgVolume},dst=/var/lib/postgresql/data`,'-e','POSTGRES_USER=hub','-e','POSTGRES_DB=hub_test','-e',`POSTGRES_PASSWORD=${password}`,'postgres:17-alpine']);await readyDb();
    await docker(['run','--detach','--init','--name',apiName,'--network',network,'--network-alias','api','--publish','127.0.0.1::3101','--mount',`type=volume,src=${volume},dst=/app/data`,
      '-e','DB_DRIVER=postgres','-e',`DATABASE_URL=postgresql://hub:${password}@postgres:5432/hub_test`,'-e',`SEED_DEMO=${seed}`,'-e',`HUB_ACCESS_TOKEN=${token}`,'-e','AI_BASE_URL=','-e','AI_API_KEY=','-e','AI_MODEL=','-e','ASR_BASE_URL=','-e','ASR_API_KEY=','-e','ASR_MODEL=',...Object.entries(asrEnvironment).flatMap(([key,value])=>['-e',`${key}=${value}`]),process.env.HUB_TEST_DOCKER_API_IMAGE||'merchant-content-hub-api:local']);
    await docker(['run','--detach','--init','--name',name,'--network',network,'--publish','127.0.0.1::3100','-e','API_INTERNAL_URL=http://api:3101',process.env.HUB_TEST_DOCKER_IMAGE]);
    await ports();await ready(apiBase,apiName);await ready(base,name);
    assert.equal((await fetch(apiBase+'/api/health').then(r=>r.json())).backend,'fastify');
    for(const container of [name,apiName])assert.notEqual(await docker(['exec',container,'id','-u']),'0');
  }
  try {
    await docker(['network','create','--label','fieldwork.qa=true',network]);
    for(const v of [volume,pgVolume])await docker(['volume','create','--label','fieldwork.qa=true',v]);
    await launch();
    return {
      get base(){return base;},get apiBase(){return apiBase;},token,directory,stop,
      async restart(){await docker(['restart',dbName]);await readyDb();await docker(['restart',apiName,name]);await ports();await ready(apiBase,apiName);await ready(base,name);},
      async recreate(){for(const container of[name,apiName,dbName])await docker(['rm','--force',container]);await launch();},
      async generateVideoFixture(target){await docker(['exec',apiName,'ffmpeg','-v','error','-y','-f','lavfi','-i','color=c=0x8f9e82:s=320x240:r=24:d=5','-f','lavfi','-i','sine=frequency=440:duration=5','-shortest','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','/tmp/fieldwork-fixture.mp4']);await docker(['cp',apiName+':/tmp/fieldwork-fixture.mp4',target]);},
      async stopApi(){await docker(['stop','--time','3',apiName]);},
      async databaseQuery(sql){return docker(['exec',dbName,'psql','-U','hub','-d','hub_test','-At','-c',sql]);},
      async apiCommand(code){return docker(['exec',apiName,'node','--input-type=module','-e',code]);}
    };
  } catch(error){await stop();throw error;}
}
