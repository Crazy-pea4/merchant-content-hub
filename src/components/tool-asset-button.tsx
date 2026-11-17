import { FolderInput } from 'lucide-react';
import { Button } from './ui/button';
import type { Asset } from '@/shared/types';

export type ToolSource = NonNullable<Asset['toolSource']>;
export interface ProjectToolProps {
  projectId: string;
  assets: Asset[];
  saveAsset: (source: ToolSource) => Promise<void>;
}

export function ToolAssetButton({ source, projectId, assets, saveAsset, busy }: ProjectToolProps & { source: ToolSource; busy: boolean }) {
  if (!projectId) return null;
  const saved = assets.some(({ toolSource }) => toolSource?.type === source.type && toolSource.id === source.id && toolSource.revision === source.revision);
  return <Button type="button" variant="outline" size="sm" disabled={busy || saved} onClick={() => void saveAsset(source)}>
    <FolderInput size={14} />{saved ? '已存入项目素材库' : '存入项目素材库'}
  </Button>;
}
