import {
  validateMediaOutput,
  type OutputValidationOptions,
  type OutputValidationResult,
} from '../core/media/output-validator';
import {
  readDirectoryFile,
  removeDirectoryFile,
  type WritableDirectoryHandle,
} from './directory-output-writer';

export async function commitValidatedDirectoryOutput(
  directory: WritableDirectoryHandle,
  finalFilename: string,
  options: OutputValidationOptions,
  partialFilename?: string,
): Promise<OutputValidationResult> {
  const output = await readDirectoryFile(directory, finalFilename);
  const validation = await validateMediaOutput(output, options);
  if (partialFilename) await removeDirectoryFile(directory, partialFilename);
  return validation;
}
