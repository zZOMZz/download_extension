import { useEffect, useMemo, useRef, useState } from 'react';
import { formatByteRate, formatBytes, formatDuration, safeFilename } from '~/src/core/format';
import { parseDashManifest, type DashManifestSummary } from '~/src/core/protocols/dash';
import {
  parseHlsPlaylist,
  type HlsMasterPlaylist,
  type HlsMediaPlaylist,
  type HlsVariant,
} from '~/src/core/protocols/hls';
import {
  downloadHlsPlaylist,
  fetchTextResource,
  validateHlsDownload,
  type HlsDownloadProgress,
} from '~/src/core/hls/download-hls';
import { listTabCandidates } from '~/src/browser/runtime-client';
import { openOutputWriter } from '~/src/browser/output-writer';
import { readSettings, setOutputFormat as persistOutputFormat } from '~/src/browser/settings';
import { TsToMp4Writer } from '~/src/browser/transmuxing-writer';
import { createTranslator, type MessageKey, type Translator } from '~/src/shared/i18n';
import type { MediaCandidate } from '~/src/shared/media';
import {
  NETWORK_PRESETS,
  outputFormatSchema,
  type AppLanguage,
  type NetworkSettings,
  type OutputFormat,
} from '~/src/shared/settings';

interface HlsState {
  master?: HlsMasterPlaylist;
  media: HlsMediaPlaylist;
  selectedVariant?: HlsVariant;
}

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

function preferredVariant(master: HlsMasterPlaylist): HlsVariant {
  return [...master.variants].sort((left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0))[0]!;
}

function outputDetails(
  candidate: MediaCandidate,
  hls: HlsState,
  outputFormat: OutputFormat,
): { filename: string; extension: string; mime: string; remuxTs: boolean } {
  const fragmentedMp4 = hls.media.segments.some((segment) => Boolean(segment.map));
  const remuxTs = outputFormat === 'mp4' && !fragmentedMp4;
  const extension = fragmentedMp4 || remuxTs ? 'mp4' : 'ts';
  const height = hls.selectedVariant?.resolution?.height;
  const base = safeFilename(candidate.title ?? 'video');
  return {
    filename: `${base}${height ? `-${height}p` : ''}.${extension}`,
    extension,
    mime: fragmentedMp4 ? 'video/mp4' : 'video/mp2t',
    remuxTs,
  };
}

export function App() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const tabId = Number(params.get('tabId'));
  const candidateId = params.get('candidateId');
  const [candidate, setCandidate] = useState<MediaCandidate | null>(null);
  const [hls, setHls] = useState<HlsState | null>(null);
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

  const inspectHls = async (
    target: MediaCandidate,
    url: string,
    master?: HlsMasterPlaylist,
    selectedVariant?: HlsVariant,
    signal?: AbortSignal,
  ) => {
    const parsed = parseHlsPlaylist(await loadText(url, signal), url);
    if (parsed.type === 'master') {
      const variant = preferredVariant(parsed);
      await inspectHls(target, variant.uri, parsed, variant, signal);
      return;
    }
    setHls({ media: parsed, ...(master ? { master } : {}), ...(selectedVariant ? { selectedVariant } : {}) });
  };

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
        if (found.kind === 'hls') await inspectHls(found, found.url, undefined, undefined, controller.signal);
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
    if (!candidate || !hls?.master) return;
    const variant = hls.master.variants.find((item) => item.uri === uri);
    if (!variant) return;
    setLoading(true);
    setError(null);
    try {
      await inspectHls(candidate, variant.uri, hls.master, variant);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('unableLoadQuality'));
    } finally {
      setLoading(false);
    }
  };

  const startDownload = async () => {
    if (!candidate || !hls) return;
    setError(null);
    const details = outputDetails(candidate, hls, outputFormat);
    try {
      const destination = await openOutputWriter(
        details.filename,
        details.remuxTs ? 'video/mp4' : details.mime,
        details.extension,
      );
      const writer = details.remuxTs
        ? new TsToMp4Writer(destination)
        : destination;
      const controller = new AbortController();
      abortController.current = controller;
      setDownloading(true);
      setProgress({
        completedSegments: 0,
        totalSegments: hls.media.segments.length,
        bytesWritten: 0,
        phase: 'requesting',
        networkBytesReceived: 0,
      });
      await downloadHlsPlaylist(hls.media, writer, {
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

  const problems = hls ? validateHlsDownload(hls.media) : [];
  const externalAudio = Boolean(
    hls?.selectedVariant?.audioGroup &&
    hls.master?.renditions.some(
      (rendition) => rendition.type === 'AUDIO' && rendition.groupId === hls.selectedVariant?.audioGroup && rendition.uri,
    ),
  );
  if (externalAudio) problems.push(t('separateAudioProblem'));

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
              <div><span>{t('segments')}</span><strong>{hls.media.segments.length}</strong></div>
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
