import {
  validateMediaOutput,
  type OutputValidationOptions,
  type OutputValidationResult,
} from '../core/media/output-validator';
import { readDirectoryFile, type WritableDirectoryHandle } from './directory-output-writer';

/** Validation never removes recovery data. TaskRuntime owns completed persistence and cleanup. */
export async function validateDirectoryOutput(
  directory: WritableDirectoryHandle,
  finalFilename: string,
  options: OutputValidationOptions,
): Promise<OutputValidationResult> {
  return validateMediaOutput(await readDirectoryFile(directory, finalFilename), options);
}
