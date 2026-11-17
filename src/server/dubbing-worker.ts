import { processNextDubbing } from './dubbing';

export function startDubbingWorker() {
  let stopped = false, running: Promise<unknown> | null = null;
  const controller = new AbortController();
  const tick = () => {
    if (stopped || running) return;
    running = processNextDubbing({ signal: controller.signal }).catch(() => { console.error('Background dubbing worker cycle failed'); }).finally(() => { running = null; });
  };
  const timer = setInterval(tick, 750); timer.unref(); tick();
  return { stop: async () => { stopped = true; clearInterval(timer); controller.abort(); await running; } };
}
