import { loadEnvironment } from './config';
loadEnvironment();
async function main() {
  const { createApi } = await import('./app');
  const { startTranscriptionWorker } = await import('../server/transcription-worker');
  const { startDubbingWorker } = await import('../server/dubbing-worker');
  const { processEditExport } = await import('../server/video-edit-media');
  const { startNarrationWorker, startMediaWorker } = await import('../server/narration-worker');
  const { startDouyinWorker } = await import('../server/douyin');
  const app = await createApi();
  const douyinWorker = process.env.DOUYIN_WORKER_ENABLED !== 'false' ? startDouyinWorker() : null;
  const worker = process.env.ASR_WORKER_ENABLED !== 'false' ? startTranscriptionWorker() : null;
  const dubbingWorker = process.env.TTS_WORKER_ENABLED !== 'false' ? startDubbingWorker() : null;
  const narrationWorker = process.env.NARRATION_WORKER_ENABLED !== 'false' ? startNarrationWorker() : null;
  const editWorker = startMediaWorker(processEditExport);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await Promise.all([editWorker.stop(), worker?.stop(), dubbingWorker?.stop(), narrationWorker?.stop(), douyinWorker?.stop()]); await app.close(); process.exit(0); };
  process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
  await app.listen({ host: process.env.API_HOST || '127.0.0.1', port: Number(process.env.API_PORT || 3101) });
  console.log('Fastify API ready');
}
main().catch((error) => { console.error('Fastify API startup failed; check database and service configuration', error?.code || error?.name || 'unknown'); process.exit(1); });
