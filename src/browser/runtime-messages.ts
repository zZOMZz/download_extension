import { RuntimeError } from '../runtime/errors';
import { hasMessageKey, type Translator } from '../shared/i18n';
import type { DownloadFailure } from '../shared/task-diagnostics';

export function runtimeErrorMessage(cause: unknown, t: Translator): string {
  if (cause instanceof RuntimeError && hasMessageKey(cause.code)) return t(cause.code, cause.params);
  return cause instanceof Error ? cause.message : t('downloadFailed');
}
export function runtimeFailureMessage(failure: DownloadFailure | undefined, fallback: string, t: Translator): string {
  return failure && hasMessageKey(failure.code) ? t(failure.code, failure.params) : fallback;
}
