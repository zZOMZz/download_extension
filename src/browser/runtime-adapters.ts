import type { ArtifactStore } from '../runtime/artifact-store';
import type { TransformBackend } from '../runtime/transform-backend';
import {
  openDirectoryOutputWriter,
  openResumableDirectoryOutputWriter,
  readDirectoryFile,
  removeDirectoryFile,
  type WritableDirectoryHandle,
} from './directory-output-writer';
import { createHlsOutputWriter } from './hls-output-writer';
import { SeparateTrackFmp4Writer } from '../runtime/media/separate-track-fmp4-writer';

export function createBrowserArtifactStore(
  directory: WritableDirectoryHandle,
  id?: string,
): ArtifactStore {
  return {
    ...(id ? { id } : {}),
    name: directory.name,
    async stat(filename) {
      const file = await readDirectoryFile(directory, filename);
      return file ? { size: file.size } : null;
    },
    async read(filename, offset, length) {
      const file = await readDirectoryFile(directory, filename);
      if (!file) throw new Error(`The output artifact is missing: ${filename}`);
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    },
    open: (filename, options) => options?.resumeFrom === undefined
      ? openDirectoryOutputWriter(directory, filename)
      : openResumableDirectoryOutputWriter(directory, filename, options.resumeFrom),
    remove: (filename) => removeDirectoryFile(directory, filename),
  };
}

export const browserTransformBackend: TransformBackend = {
  createHlsWriter: createHlsOutputWriter,
  createDashWriter: (destination, videoSegments, audioSegments) =>
    new SeparateTrackFmp4Writer(destination, videoSegments, audioSegments),
};
