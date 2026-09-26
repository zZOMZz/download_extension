import { useEffect, useRef, useState } from 'react';
import type { DownloadTaskProgress } from '../shared/download-task';

/** Sample the whole panel together; per-chunk and per-segment events stay internal. */
export function useProgressSnapshot(progress: DownloadTaskProgress): DownloadTaskProgress {
  const latest = useRef(progress);
  const [snapshot, setSnapshot] = useState(progress);

  useEffect(() => {
    latest.current = progress;
  }, [progress]);

  const immediate = progress.phase === 'retrying'
    || progress.phase === 'finalizing'
    || progress.phase === 'completed';
  useEffect(() => {
    if (immediate) {
      setSnapshot(latest.current);
      return;
    }
    const timer = setInterval(() => setSnapshot(latest.current), 500);
    return () => clearInterval(timer);
  }, [immediate]);

  // Terminal/retry transitions cannot wait for the next display tick.
  return immediate ? progress : snapshot;
}
