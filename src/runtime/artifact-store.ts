import type { RandomAccessBinaryWriter } from '../core/hls/download-hls';
import type { RandomAccessMedia } from '../core/media/output-validator';

/** Output namespace identity belongs to the host; its display name is not an identity. */
export interface ArtifactStore {
  readonly id?: string;
  readonly name: string;
  stat(filename: string): Promise<{ size: number } | null>;
  read(filename: string, offset: number, length: number): Promise<Uint8Array>;
  /** resumeFrom truncates to that committed boundary and preserves partial writes on abort. */
  open(filename: string, options?: { resumeFrom?: number }): Promise<RandomAccessBinaryWriter>;
  remove(filename: string): Promise<void>;
}

export async function readMediaArtifact(
  artifacts: ArtifactStore,
  filename: string,
): Promise<RandomAccessMedia | null> {
  const stat = await artifacts.stat(filename);
  return stat ? {
    size: stat.size,
    read: (offset, length) => artifacts.read(filename, offset, length),
  } : null;
}
