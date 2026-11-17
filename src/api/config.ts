import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
export function loadEnvironment() {
  const existing = new Set(Object.keys(process.env)); let values: Record<string,string | undefined> = {};
  for (const file of ['.env', '.env.local']) if (existsSync(file)) values = { ...values, ...parseEnv(readFileSync(file, 'utf8')) };
  for (const [key,value] of Object.entries(values)) if (!existing.has(key)) process.env[key] = value;
}
export function allowedOrigins() {
  return (process.env.HUB_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
    const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('HUB_ALLOWED_ORIGINS 必须为完整的 HTTP/HTTPS 来源');
    return url.origin;
  });
}
