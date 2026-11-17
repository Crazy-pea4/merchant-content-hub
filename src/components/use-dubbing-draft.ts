'use client';
import { useEffect, useRef, useState } from 'react';
import { DUBBING_DRAFT_KEY, readDubbingDraft, type DubbingDraft } from '@/shared/dubbing-draft';

export function useDubbingDraft(projectId: string, value: DubbingDraft, restore: (draft: DubbingDraft) => void) {
  const [ready, setReady] = useState(false), [status, setStatus] = useState<'loading' | 'saved' | 'error'>('loading');
  const storageKey = projectId ? DUBBING_DRAFT_KEY + ':' + projectId : DUBBING_DRAFT_KEY;
  const [legacy, setLegacy] = useState<DubbingDraft | null>(null);
  const serialized = JSON.stringify(value), latest = useRef(serialized), restoreRef = useRef(restore);
  latest.current = serialized; restoreRef.current = restore;
  useEffect(() => {
    try {
      const saved = readDubbingDraft(localStorage.getItem(storageKey));
      if (saved) restoreRef.current(saved);
      if (projectId) setLegacy(readDubbingDraft(localStorage.getItem(DUBBING_DRAFT_KEY)));
    }
    catch { setStatus('error'); }
    setReady(true);
  }, [storageKey, projectId]);
  useEffect(() => {
    // Do not overwrite a saved draft with the first render's empty form.
    if (!ready) return;
    const save = () => {
      try { localStorage.setItem(storageKey, latest.current); setStatus('saved'); }
      catch { setStatus('error'); }
    };
    save(); window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [ready, serialized, storageKey]);
  const canRestoreLegacy = ready && !!legacy && !!(legacy.text || legacy.title || legacy.voiceId || legacy.sourceId) && !value.text && !value.title && !value.sourceId && !value.voiceId;
  function restoreLegacy() {
    if (canRestoreLegacy && legacy) restoreRef.current(legacy);
  }
  return { ready, status, canRestoreLegacy, restoreLegacy };
}
