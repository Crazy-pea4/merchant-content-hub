process.env.HUB_TEST_DOCKER_IMAGE ||= 'merchant-content-hub:local';
await import('./smoke.mjs');
