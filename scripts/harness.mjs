import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function startHarness({ seed = false, auth = true, asrEnvironment = {} } = {}) {
  if (process.env.HUB_TEST_DOCKER_IMAGE) {
    const { startDockerHarness } = await import('./docker-harness.mjs');
    return startDockerHarness({ seed, auth, asrEnvironment });
  }
  const directory = await mkdtemp(join(tmpdir(), 'fieldwork-qa-'));
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const second = createServer(); await new Promise(resolve => second.listen(0, '127.0.0.1', resolve)); const apiPort = second.address().port; await new Promise(resolve => second.close(resolve));
  const token = auth ? randomBytes(24).toString('hex') : '';
  let output = '';
  const child = spawn(process.execPath, ['scripts/run.mjs', 'start'], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', DB_DRIVER: 'sqlite', DATABASE_URL: '', LEGACY_SQLITE_PATH: '', PORT: String(port), API_PORT: String(apiPort), DATA_DIR: join(directory, 'data'), SEED_DEMO: String(seed), HUB_ACCESS_TOKEN: token, AI_BASE_URL: '', AI_API_KEY: '', AI_MODEL: '', ASR_BASE_URL: '', ASR_API_KEY: '', ASR_MODEL: '', TTS_BASE_URL: '', TTS_API_KEY: '', TTS_MODEL: '', VISION_BASE_URL: '', VISION_API_KEY: '', VISION_MODEL: '', ...asrEnvironment }, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-10000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-10000); });
  const base = `http://127.0.0.1:${port}`;
  async function stop() {
    if (child.exitCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      await Promise.race([exited, pause(3000)]);
      if (child.exitCode === null) { child.kill('SIGKILL'); await Promise.race([exited, pause(1000)]); }
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error('QA server stopped: ' + output);
      try { const response = await fetch(base + '/api/health'); if (response.ok) return { base, token, directory, stop }; } catch {}
      await pause(150);
    }
    throw new Error('QA server timeout: ' + output);
  } catch (error) { await stop(); throw error; }
}
