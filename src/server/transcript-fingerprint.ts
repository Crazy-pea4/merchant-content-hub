import { createHash } from 'node:crypto';
import type { Asset } from '../shared/types';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,val]) => [key,canonical(val)]));
  return value;
}
export const transcriptFingerprint = (asset: Asset) => createHash('sha256').update(JSON.stringify([asset.storageKey, canonical(asset.segments)])).digest('hex');
export const legacyTranscriptFingerprint = (asset: Asset) => createHash('sha256').update(JSON.stringify([asset.storageKey, asset.segments])).digest('hex');
