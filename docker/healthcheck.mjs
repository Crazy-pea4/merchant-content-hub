try {
  const port = process.env.PORT || '3100';
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(4000) });
  const body = await response.json();
  process.exit(response.ok && body.ok === true ? 0 : 1);
} catch {
  process.exit(1);
}
