import { processNextNarration } from './narration';

export function startNarrationWorker() {
  let stopped = false, running: Promise<unknown> | null = null;
  const controller = new AbortController();
  const tick = () => {
    if (stopped || running) return;
    running = processNextNarration({ signal: controller.signal }).catch(() => { console.error('Background narration worker cycle failed'); }).finally(() => { running = null; });
  };
  const timer = setInterval(tick, 1000); timer.unref(); tick();
  return { stop: async () => { stopped = true; clearInterval(timer); controller.abort(); await running; } };
}
