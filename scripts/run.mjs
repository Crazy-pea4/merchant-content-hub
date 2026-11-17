import { spawn } from 'node:child_process';
const dev = process.argv[2] === 'dev';
const apiPort = process.env.API_PORT || '3101';
const webPort = process.env.PORT || '3100';
const children = [];
const webEnvironment = { ...process.env, API_INTERNAL_URL: process.env.API_INTERNAL_URL || `http://127.0.0.1:${apiPort}`, AI_API_KEY: '', ASR_API_KEY: '', TTS_API_KEY: '', VISION_API_KEY: '', HUB_ACCESS_TOKEN: '', DATABASE_URL: '', ASR_WORKER_ENABLED: 'false', TTS_WORKER_ENABLED: 'false', NARRATION_WORKER_ENABLED: 'false' };
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 8000); timer.unref();
  Promise.all(children.map(child => new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)))).then(() => process.exit(code));
}
function start(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' }); children.push(child);
  child.once('error', () => stop(1)); child.once('exit', code => { if (!stopping) stop(code || 0); });
}
start(dev ? ['--watch','--import','tsx','src/api/main.ts'] : ['dist/api/api/main.js'], { ...process.env, API_PORT: apiPort });
start(['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '-H', '127.0.0.1', '-p', webPort], webEnvironment);
process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
