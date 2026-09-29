export type RuntimeErrorCode =
  | 'browserSourceUnavailable'
  | 'browserSourceBusy'
  | 'browserSourceUnsupported'
  | 'browserSourceExpired'
  | 'browserSourceNetwork'
  | 'browserSourceIncomplete'
  | 'browserSourceChanged'
  | 'browserSourcePlanChanged'
  | 'chooseDirectoryBeforeQueue'
  | 'outputConflict'
  | 'runtimeBusy'
  | 'runtimeLockUnavailable'
  | 'taskNotFound'
  | 'batchProtocolUnsupported'
  | 'partialMissingOrShort'
  | 'partialClosedEarly'
  | 'separateAudioRequiresMp4'
  | 'mixedSeparateTrackContainers'
  | 'refreshedStreamIncompatible'
  | 'chooseOriginalFolderResume'
  | 'refreshedPlaylistMismatch'
  | 'savedPartialNotFound'
  | 'refreshedDashMismatch'
  | 'dashCheckpointProtocolMismatch';

/** Stable machine-readable failure; presentation and localization belong to the client. */
export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly params: Record<string, string | number>;

  constructor(code: RuntimeErrorCode, params: Record<string, string | number> = {}) {
    super(code);
    this.name = 'RuntimeError';
    this.code = code;
    this.params = params;
  }
}
