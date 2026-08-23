import { useEffect, useMemo, useRef, useState } from 'react';
import { formatByteRate, formatBytes, formatDuration, safeFilename } from '~/src/core/format';
import { parseDashManifest, type DashManifestSummary } from '~/src/core/protocols/dash';
import type { HlsRendition, HlsVariant } from '~/src/core/protocols/hls';
import {
  downloadHlsPlaylist,
  fetchTextResource,
  validateHlsDownload,
  type HlsDownloadProgress,
} from '~/src/core/hls/download-hls';
import { inspectHlsUrl, inspectHlsVariant, type InspectedHls } from '~/src/core/hls/inspect-hls';
import {
  combinedHlsMediaPlaylist,
  hlsPlaylistUsesFmp4,
} from '~/src/core/hls/media-bundle';
import { createHlsOutputPlan, type HlsOutputPlan } from '~/src/core/hls/output-plan';
import { listTabCandidates } from '~/src/browser/runtime-client';
import { openOutputWriter } from '~/src/browser/output-writer';
import { readSettings, setOutputFormat as persistOutputFormat } from '~/src/browser/settings';
import { createHlsOutputWriter } from '~/src/browser/hls-output-writer';
import { createTranslator, type MessageKey, type Translator } from '~/src/shared/i18n';
import type { MediaCandidate } from '~/src/shared/media';
import {
  NETWORK_PRESETS,
  outputFormatSchema,
  type AppLanguage,
  type NetworkSettings,
  type OutputFormat,
} from '~/src/shared/settings';

const PHASE_LABEL_KEYS: Record<NonNullable<HlsDownloadProgress['phase']>, MessageKey> = {
  requesting: 'phaseRequesting',
  downloading: 'phaseDownloading',
  decrypting: 'phaseDecrypting',
  processing: 'phaseProcessing',
  finalizing: 'phaseFinalizing',
  retrying: 'phaseRetrying',
  completed: 'phaseCompleted',
};

function progressValue(progress: HlsDownloadProgress): number {
  if (!progress.currentSegmentBytesTotal) return progress.completedSegments;
  const fraction = (progress.currentSegmentBytesReceived ?? 0) / progress.currentSegmentBytesTotal;
  return Math.min(progress.totalSegments, progress.completedSegments + Math.min(1, fraction));
}

function variantLabel(variant: HlsVariant, t: Translator): string {
  const parts = [
    variant.resolution ? `${variant.resolution.width}×${variant.resolution.height}` : null,
    variant.bandwidth ? `${(variant.bandwidth / 1_000_000).toFixed(1)} Mbps` : null,
    variant.codecs ?? null,
  ];
  return parts.filter(Boolean).join(' · ') || t('unknownQuality');
}

function audioRenditionLabel(rendition: HlsRendition, t: Translator): string {
  return [rendition.name, rendition.language, rendition.channels].filter(Boolean).join(' · ') || t('audioTrack');
}

interface HlsOutputDetails extends HlsOutputPlan {
  filename: string;
  mime: string;
}

function outputDetails(
  candidate: MediaCandidate,
  hls: InspectedHls,
  outputFormat: OutputFormat,
): HlsOutputDetails {
  const plan = createHlsOutputPlan(hls, outputFormat);
  const height = hls.selectedVariant?.resolution?.height;
  const base = safeFilename(candidate.title ?? 'video');
  return {
    ...plan,
    filename: `${base}${height ? `-${height}p` : ''}.${plan.extension}`,
    mime: plan.mimeType,
  };
}

export function App() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const tabId = Number(params.get('tabId'));
  const candidateId = params.get('candidateId');
  const [candidate, setCandidate] = useState<MediaCandidate | null>(null);
  const [hls, setHls] = useState<InspectedHls | null>(null);
  const [dash, setDash] = useState<DashManifestSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<HlsDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('mp4');
  const [networkSettings, setNetworkSettings] = useState<NetworkSettings>(NETWORK_PRESETS.resilient);
  const abortController = useRef<AbortController | null>(null);
  const t = useMemo(() => createTranslator(language), [language]);

  const networkPolicy = {
    maxAttempts: networkSettings.maxAttempts,
    firstByteTimeoutMs: networkSettings.firstByteTimeoutSeconds * 1_000,
    idleTimeoutMs: networkSettings.idleTimeoutSeconds * 1_000,
  };
  const loadText = (url: string, signal?: AbortSignal) => fetchTextResource(url, signal, networkPolicy);

  useEffect(() => {
    void readSettings().then((settings) => {
      setLanguage(settings.language);
      setOutputFormat(settings.outputFormat);
      setNetworkSettings(settings.network);
    });
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t('mediaDownload');
  }, [language, t]);

  useEffect(() => {
    const controller = new AbortController();
    abortController.current = controller;
    void (async () => {
      try {
        if (!Number.isInteger(tabId) || tabId < 0 || !candidateId) throw new Error(t('invalidDownloadUrl'));
        const found = (await listTabCandidates(tabId)).find((item) => item.id === candidateId);
        if (!found) throw new Error(t('candidateExpired'));
        setCandidate(found);
        if (found.kind === 'hls') setHls(await inspectHlsUrl(found.url, loadText, controller.signal));
        else if (found.kind === 'dash') setDash(parseDashManifest(await loadText(found.url, controller.signal)));
        else throw new Error(t('unsupportedStreamDownloader'));
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('unableInspectMedia'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [candidateId, tabId]);

  const changeVariant = async (uri: string) => {
    if (!hls?.master) return;
    const variant = hls.master.variants.find((item) => item.uri === uri);
    if (!variant) return;
    setLoading(true);
    setError(null);
    try {
      setHls(await inspectHlsVariant(hls.master, variant, loadText));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('unableLoadQuality'));
    } finally {
      setLoading(false);
    }
  };

  const changeAudioRendition = async (uri: string) => {
    if (!hls?.master || !hls.selectedVariant) return;
    const rendition = hls.master.renditions.find((item) => item.uri === uri);
    if (!rendition) return;
    setLoading(true);
    setError(null);
    try {
      setHls(await inspectHlsVariant(hls.master, hls.selectedVariant, loadText, undefined, rendition));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('unableLoadAudioTrack'));
    } finally {
      setLoading(false);
    }
  };

  const startDownload = async () => {
    if (!candidate || !hls) return;
    setError(null);
    const details = outputDetails(candidate, hls, outputFormat);
    const downloadPlaylist = combinedHlsMediaPlaylist(hls);
    try {
      const destination = await openOutputWriter(
        details.filename,
        details.remuxTs ? 'video/mp4' : details.mime,
        details.extension,
      );
      const writer = createHlsOutputWriter(destination, details);
      const controller = new AbortController();
      abortController.current = controller;
      setDownloading(true);
      setProgress({
        completedSegments: 0,
        totalSegments: downloadPlaylist.segments.length,
        bytesWritten: 0,
        phase: 'requesting',
        networkBytesReceived: 0,
      });
      await downloadHlsPlaylist(downloadPlaylist, writer, {
        signal: controller.signal,
        networkPolicy,
        loadText,
        onProgress: setProgress,
      });
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : t('downloadFailed'));
      }
    } finally {
      setDownloading(false);
    }
  };

  const changeOutputFormat = async (value: string) => {
    const format = outputFormatSchema.parse(value);
    setOutputFormat(format);
    try {
      await persistOutputFormat(format);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('unableSaveOutput'));
    }
  };

  const problems = hls ? [
    ...validateHlsDownload(hls.media),
    ...(hls.audioMedia ? validateHlsDownload(hls.audioMedia) : []),
  ] : [];
  const externalAudio = Boolean(hls?.audioMedia);
  if (hls?.audioMedia && outputFormat !== 'mp4') problems.push(t('separateAudioRequiresMp4'));
  if (
    hls?.audioMedia &&
    hlsPlaylistUsesFmp4(hls.media) !== hlsPlaylistUsesFmp4(hls.audioMedia)
  ) problems.push(t('mixedSeparateTrackContainers'));

  return (
    <main>
      <div className="brand">{t('appName')}</div>
      <section className="panel">
        <p className="eyebrow">{t('streamInspection')}</p>
        <h1>{candidate?.title ?? t('mediaDownload')}</h1>
        {candidate && <p className="source">{candidate.url}</p>}

        {loading && <div className="status">{t('readingManifest')}</div>}
        {error && <div className="notice error">{error}</div>}

        {hls && (
          <>
            <div className="facts">
              <div><span>{t('protocol')}</span><strong>HLS</strong></div>
              <div><span>{t('segments')}</span><strong>{combinedHlsMediaPlaylist(hls).segments.length}</strong></div>
              <div><span>{t('duration')}</span><strong>{Math.round(hls.media.segments.reduce((sum, segment) => sum + segment.duration, 0))}s</strong></div>
              <div><span>{t('playlist')}</span><strong>{hls.media.endList ? 'VOD' : t('live')}</strong></div>
            </div>

            {hls.master && (
              <label>
                {t('quality')}
                <select
                  value={hls.selectedVariant?.uri}
                  disabled={downloading}
                  onChange={(event) => void changeVariant(event.target.value)}
                >
                  {hls.master.variants.map((variant) => (
                    <option value={variant.uri} key={variant.uri}>{variantLabel(variant, t)}</option>
                  ))}
                </select>
              </label>
            )}

            {hls.master && hls.selectedAudioRendition && (
              <label>
                {t('audioTrack')}
                <select
                  value={hls.selectedAudioRendition?.uri}
                  disabled={downloading}
                  onChange={(event) => void changeAudioRendition(event.target.value)}
                >
                  {hls.master.renditions
                    .filter((rendition) =>
                      rendition.type === 'AUDIO' &&
                      rendition.groupId === hls.selectedVariant?.audioGroup &&
                      rendition.uri)
                    .map((rendition) => (
                      <option value={rendition.uri} key={rendition.uri}>
                        {audioRenditionLabel(rendition, t)}
                      </option>
                    ))}
                </select>
              </label>
            )}

            <label>
              {t('outputFormat')}
              <select
                value={outputFormat}
                disabled={downloading}
                onChange={(event) => void changeOutputFormat(event.target.value)}
              >
                <option value="mp4">{t('mp4RecommendedNoReencode')}</option>
                <option value="original">{t('originalStreamFormat')}</option>
              </select>
            </label>

            {outputFormat === 'mp4' && !hls.media.segments.some((segment) => Boolean(segment.map)) && (
              <div className="notice info">
                {t('tsRemuxNotice')}
              </div>
            )}

            {externalAudio && (
              <div className="notice info">
                {t('separateAudioMuxNotice', {
                  track: hls.selectedAudioRendition ? audioRenditionLabel(hls.selectedAudioRendition, t) : t('audioTrack'),
                })}
              </div>
            )}

            {problems.map((problem) => <div className="notice warning" key={problem}>{problem}</div>)}

            {progress && (
              <div className="progress-block">
                <div className="progress-copy">
                  <span>{t('segmentsProgress', { completed: progress.completedSegments, total: progress.totalSegments })}</span>
                  <span>{formatBytes(progress.bytesWritten)}</span>
                </div>
                <progress value={progressValue(progress)} max={progress.totalSegments} />
                <div className="progress-metrics">
                  <span>{progress.phase ? t(PHASE_LABEL_KEYS[progress.phase]) : t('downloading')}</span>
                  {formatByteRate(progress.currentSpeedBytesPerSecond) && (
                    <span>{t('nowRate', { rate: formatByteRate(progress.currentSpeedBytesPerSecond)! })}</span>
                  )}
                  {formatByteRate(progress.averageSpeedBytesPerSecond) && (
                    <span>{t('averageRate', { rate: formatByteRate(progress.averageSpeedBytesPerSecond)! })}</span>
                  )}
                  {formatDuration(progress.estimatedSecondsRemaining) && (
                    <span>{t('eta', { duration: formatDuration(progress.estimatedSecondsRemaining)! })}</span>
                  )}
                  {formatBytes(progress.currentSegmentBytesReceived) && formatBytes(progress.currentSegmentBytesTotal) && (
                    <span>
                      {t('segmentBytes', {
                        received: formatBytes(progress.currentSegmentBytesReceived)!,
                        total: formatBytes(progress.currentSegmentBytesTotal)!,
                      })}
                    </span>
                  )}
                  {progress.lastSegmentDurationMs !== undefined && (
                    <span>{t('lastSegment', { duration: formatDuration(progress.lastSegmentDurationMs / 1_000)! })}</span>
                  )}
                </div>
                {progress.phase === 'retrying' && (
                  <p className="retry-detail">
                    {t('retryAttempt', {
                      attempt: progress.retryAttempt ?? 0,
                      max: progress.maxAttempts ?? 0,
                      duration: formatDuration((progress.retryDelayMs ?? 0) / 1_000) ?? '0s',
                    })}
                    {progress.retryReason ? ` · ${progress.retryReason}` : ''}
                  </p>
                )}
              </div>
            )}

            <div className="actions">
              <button
                className="primary"
                disabled={downloading || problems.length > 0}
                onClick={() => void startDownload()}
              >
                {downloading ? t('downloadingEllipsis') : t('chooseFileDownload')}
              </button>
              {downloading && (
                <button className="secondary" onClick={() => abortController.current?.abort()}>{t('cancel')}</button>
              )}
            </div>
          </>
        )}

        {dash && (
          <>
            <div className="facts">
              <div><span>{t('protocol')}</span><strong>DASH</strong></div>
              <div><span>{t('mode')}</span><strong>{dash.type}</strong></div>
              <div><span>{t('tracks')}</span><strong>{dash.representations.length}</strong></div>
              <div><span>{t('protection')}</span><strong>{dash.hasContentProtection ? t('detected') : t('noneDetected')}</strong></div>
            </div>
            <div className="notice warning">
              {t('dashMuxNotice')}
            </div>
          </>
        )}
      </section>
      <p className="footnote">{t('mediaPermissionFootnote')}</p>
    </main>
  );
}
