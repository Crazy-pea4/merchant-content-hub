import type { Asset } from './types';

export const MAX_CREATION_SOURCES = 30;
export type CreationReferenceMode = 'manual' | 'auto';
export interface CreationReference { mode: CreationReferenceMode; assetIds?: string[] }
export function eligibleCreationSources(assets: Asset[], projectId: string, today = new Date().toISOString().slice(0, 10)) {
  return assets.filter(asset => asset.projectId === projectId && asset.rights === 'authorized' && (!asset.expiresAt || asset.expiresAt >= today));
}
// Auto mode preserves the previous order and limit; it does not rank by topic.
export function creationSources(assets: Asset[], projectId: string, today = new Date().toISOString().slice(0, 10)) {
  return eligibleCreationSources(assets, projectId, today).slice(0, MAX_CREATION_SOURCES);
}
export function resolveCreationSources(assets: Asset[], projectId: string, reference: CreationReference) {
  if (reference.mode === 'auto') {
    if (reference.assetIds !== undefined) throw new Error('自动参考不能同时指定素材，请切换为手动选择');
    return creationSources(assets, projectId);
  }
  const ids = reference.assetIds;
  if (!ids?.length) throw new Error('请至少选择 1 份参考素材');
  if (ids.length > MAX_CREATION_SOURCES) throw new Error(`每次最多选择 ${MAX_CREATION_SOURCES} 份参考素材`);
  if (new Set(ids).size !== ids.length) throw new Error('参考素材不能重复选择');
  const eligible = new Map(eligibleCreationSources(assets, projectId).map(asset => [asset.id, asset]));
  if (ids.some(id => !eligible.has(id))) throw new Error('所选参考素材已被删除、未授权、已过期或不属于当前项目，请重新选择');
  return ids.map(id => eligible.get(id)!);
}
