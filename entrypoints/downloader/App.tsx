import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '~/src/core/format';
import { candidateVideoQualities, selectedVideoQuality, videoQualityLabel } from '~/src/core/media-quality';
import { ProgressMetrics } from '~/src/components/progress-metrics';
import { BrandMark } from '~/src/components/brand-mark';
import { LiquidShader } from '~/src/components/liquid-shader';
import { parseDashMediaSource } from '~/src/core/protocols/dash';
import { preferredDashTrack } from '~/src/core/dash/download-dash';
import type { HlsRendition, HlsVariant } from '~/src/core/protocols/hls';
import {
  fetchTextResource,
  validateHlsDownload,
  type HlsDownloadProgress,
} from '~/src/core/hls/download-hls';
import { inspectHlsUrl, inspectHlsVariant, type InspectedHls } from '~/src/core/hls/inspect-hls';
import { combinedHlsMediaPlaylist, hlsPlaylistUsesFmp4 } from '~/src/core/hls/media-bundle';
import { configureCandidateRequestAdapter, getYouTubeSabrContext, listTabCandidates } from '~/src/browser/runtime-client';
import { openOutputTarget } from '~/src/browser/output-writer';
import { describeBrowserDirectOutput, runBrowserDirectDownload } from '~/src/browser/direct-download';
import type { DirectMediaSelection } from '~/src/runtime/direct-download';
import { runtimeErrorMessage } from '~/src/browser/runtime-messages';
import { readSettings, setOutputFormat as persistOutputFormat } from '~/src/browser/settings';
import { createTranslator, type Translator } from '~/src/shared/i18n';
import type { DashMediaSource, DashTrack, MediaCandidate, YouTubeSabrFormat } from '~/src/shared/media';
import {
  NETWORK_PRESETS,
  outputFormatSchema,
  type AppLanguage,
  type NetworkSettings,
  type OutputFormat,
} from '~/src/shared/settings';

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

function dashTrackLabel(track: DashTrack, t: Translator): string {
  const parts = track.kind === 'video'
    ? [
        track.width && track.height ? `${track.width}×${track.height}` : null,
        track.frameRate ? `${Math.round(track.frameRate)} fps` : null,
        track.bandwidth ? `${(track.bandwidth / 1_000_000).toFixed(1)} Mbps` : null,
        track.codecs ?? null,
      ]
    : [
        track.bandwidth ? `${Math.round(track.bandwidth / 1_000)} kbps` : null,
        track.codecs ?? null,
      ];
  return parts.filter(Boolean).join(' · ') || t('unknownQuality');
}

function sabrFormatLabel(format: YouTubeSabrFormat): string {
  return [
    format.width && format.height ? `${format.width}×${format.height}` : null,
    format.fps ? `${format.fps} fps` : null,
    `${Math.round((format.averageBitrate ?? format.bitrate) / 1_000)} kbps`,
    format.audioTrack?.displayName,
    /codecs="([^"]+)"/.exec(format.mimeType)?.[1],
  ].filter(Boolean).join(' · ');
}

function progressPanel(progress: HlsDownloadProgress | null, t: Translator, tracks = false) {
  if (!progress) return null;
  return (
    <div className="progress-block">
      <div className="progress-copy">
        <span>{t(tracks ? 'tracksProgress' : 'segmentsProgress', { completed: progress.completedSegments, total: progress.totalSegments })}</span>
        <span>{formatBytes(progress.bytesWritten)}</span>
      </div>
      <progress value={progressValue(progress)} max={progress.totalSegments} />
      <ProgressMetrics progress={progress} t={t} />
    </div>
  );
}

export function App() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const tabId = Number(params.get('tabId'));
  const candidateId = params.get('candidateId');
  const requestedVideoTrackId = params.get('videoTrackId');
  const [candidate, setCandidate] = useState<MediaCandidate | null>(null);
  const [hls, setHls] = useState<InspectedHls | null>(null);
  const [dash, setDash] = useState<DashMediaSource | null>(null);
  const [dashVideoId, setDashVideoId] = useState('');
  const [dashAudioId, setDashAudioId] = useState('');
  const [sabrVideoItag, setSabrVideoItag] = useState(0);
  const [sabrAudioItag, setSabrAudioItag] = useState(0);
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
        if (found.siteAdapterId) {
          await configureCandidateRequestAdapter(found.tabId, found.id);
        }
        setCandidate(found);
        if (found.hasContentProtection) throw new Error(t('protectedMediaUnsupported'));
        if (found.kind === 'hls') setHls(await inspectHlsUrl(found.url, loadText, controller.signal));
        else if (found.kind === 'dash') {
          const source = found.dash ?? parseDashMediaSource(await loadText(found.url, controller.signal), found.url);
          setDash(source);
          setDashVideoId(selectedVideoQuality(candidateVideoQualities({ kind: 'dash', dash: source }), requestedVideoTrackId) || preferredDashTrack(source, 'video')?.id || '');
          setDashAudioId(preferredDashTrack(source, 'audio')?.id ?? '');
        }
        else if (found.kind === 'sabr' && found.youtubeSabr) {
          setSabrVideoItag(Number(selectedVideoQuality(candidateVideoQualities(found), requestedVideoTrackId)));
          const audio = [...found.youtubeSabr.formats]
            .filter((format) => format.mimeType.startsWith('audio/mp4'))
            .sort((a, b) => Number(Boolean(b.audioTrack?.audioIsDefault)) - Number(Boolean(a.audioTrack?.audioIsDefault)) || b.bitrate - a.bitrate);
          setSabrAudioItag(audio[0]?.itag ?? 0);
          // Surface unavailable playback sessions before the user chooses a file.
          await getYouTubeSabrContext(found.tabId, found.id);
        }
        else if (found.kind !== 'progressive') throw new Error(t('unsupportedStreamDownloader'));
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('unableInspectMedia'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => { controller.abort(); abortController.current?.abort(); };
  }, [candidateId, tabId, requestedVideoTrackId]);

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

  const startDownload = async (selection: DirectMediaSelection) => {
    if (!candidate || downloading || candidate.hasContentProtection) return;
    setError(null);
    setProgress(null);
    setDownloading(true);
    const controller = new AbortController();
    abortController.current = controller;
    try {
      const output = describeBrowserDirectOutput(selection, candidate);
      // Invoke the picker before any await while the click still grants user activation.
      const pendingTarget = openOutputTarget(output.filename, output.mimeType, output.extension, {
        allowMemoryFallback: output.allowMemoryFallback,
      });
      await runBrowserDirectDownload(selection, pendingTarget, {
        sourceTabId: candidate.tabId,
        candidateId: candidate.id,
        signal: controller.signal,
        networkPolicy,
        onProgress: setProgress,
      });
    } catch (cause) {
      if (!controller.signal.aborted && !(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(runtimeErrorMessage(cause, t));
      }
    } finally {
      if (abortController.current === controller) abortController.current = null;
      setDownloading(false);
    }
  };

  const startHlsDownload = () => hls && startDownload({ kind: 'hls', hls, outputFormat });
  const startProgressiveDownload = () => candidate?.kind === 'progressive' && startDownload({
    kind: 'progressive', url: candidate.url,
    ...(candidate.contentLength === undefined ? {} : { contentLength: candidate.contentLength }),
  });
  const startDashDownload = () => dash && startDownload({
    kind: 'dash', source: dash, videoTrackId: dashVideoId, audioTrackId: dashAudioId,
  });
  const startSabrDownload = () => candidate?.youtubeSabr && sabrVideoItag && sabrAudioItag && startDownload({
    kind: 'sabr', source: candidate.youtubeSabr, videoItag: sabrVideoItag, audioItag: sabrAudioItag,
  });

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
  const dashVideoTracks = dash?.tracks.filter((track) => track.kind === 'video') ?? [];
  const dashAudioTracks = dash?.tracks.filter((track) => track.kind === 'audio') ?? [];
  const videoQualities = candidateVideoQualities(dash ? { kind: 'dash', dash } : candidate ?? { kind: 'blob' });
  const selectedQuality = videoQualities.find(({ id }) => id === (dash ? dashVideoId : String(sabrVideoItag)));
  const dashProblems: string[] = [];
  if (dash?.type === 'dynamic') dashProblems.push(t('dashLiveUnsupported'));
  if (dash?.hasContentProtection) dashProblems.push(t('dashDrmUnsupported'));
  if (dash && !dashVideoTracks.length) dashProblems.push(t('dashMissingVideo'));
  if (dash && !dashAudioTracks.length) dashProblems.push(t('dashMissingAudio'));

  return (
    <>
      <LiquidShader />
      <main>
        <header className="downloader-header">
          <BrandMark />
          <span className="page-context">{t('mediaDownload')}</span>
        </header>
        <section className="panel">
        <div className={`media-overview${candidate?.thumbnailUrl ? ' has-cover' : ''}`}>
          {candidate?.thumbnailUrl && <div className="media-cover">
            <img src={candidate.thumbnailUrl} alt={t('videoThumbnail')} referrerPolicy="no-referrer" />
            {selectedQuality && <span className="cover-quality">{videoQualityLabel(selectedQuality)}</span>}
          </div>}
          <div className="media-overview-copy">
            <p className="eyebrow">{t('mediaDownload')}</p>
            <h1>{candidate?.title ?? t('mediaDownload')}</h1>
            {videoQualities.length > 0 && <p className="selection-intro">{t('chooseDownloadQuality')}</p>}
            {candidate && <p className="source">{candidate.sourcePageUrl ?? candidate.url}</p>}
          </div>
        </div>

        {loading && <div className="status">{t('readingManifest')}</div>}
        {error && <div className="notice error">{error}</div>}
        {candidate?.isPreview && <div className="notice info">{t('previewOnly')}</div>}

        {!loading && candidate?.kind === 'progressive' && (
          <>
            <div className="facts">
              <div><span>{t('protocol')}</span><strong>MP4</strong></div>
              <div><span>{t('outputFormat')}</span><strong>MP4</strong></div>
            </div>
            {progressPanel(progress, t)}
            <div className="actions">
              <button
                className="primary"
                disabled={downloading || candidate.hasContentProtection}
                onClick={() => void startProgressiveDownload()}
              >
                {downloading ? t('downloadingEllipsis') : t('chooseFileDownload')}
              </button>
              {downloading && (
                <button className="secondary" onClick={() => abortController.current?.abort()}>{t('cancel')}</button>
              )}
            </div>
          </>
        )}

        {!loading && candidate?.kind === 'sabr' && candidate.youtubeSabr && (
          <>
            <div className="facts">
              <div><span>{t('resolution')}</span><strong>{selectedQuality ? videoQualityLabel(selectedQuality) : '—'}</strong></div>
              <div><span>{t('duration')}</span><strong>{Math.round(candidate.youtubeSabr.durationSeconds)}s</strong></div>
              <div><span>{t('outputFormat')}</span><strong>MP4</strong></div>
            </div>
            {videoQualities.length > 0 && <label className="resolution-field">
              {t('resolution')}
              <select value={sabrVideoItag} disabled={downloading} onChange={(event) => {
                setSabrVideoItag(Number(event.target.value)); setProgress(null); setError(null);
              }}>
                {videoQualities.map((quality, index) => (
                  <option key={quality.id} value={quality.id}>{videoQualityLabel(quality)}{index === 0 ? ` · ${t('highestAvailable')}` : ''}</option>
                ))}
              </select>
            </label>}
            <label>
              {t('audioTrack')}
              <select value={sabrAudioItag} disabled={downloading} onChange={(event) => {
                setSabrAudioItag(Number(event.target.value)); setProgress(null); setError(null);
              }}>
                {candidate.youtubeSabr.formats.filter((format) => format.mimeType.startsWith('audio/mp4')).map((format) => (
                  <option key={`${format.itag}-${format.audioTrack?.id ?? ''}`} value={format.itag}>{sabrFormatLabel(format)}</option>
                ))}
              </select>
            </label>
            <div className="notice info">{t('dashMuxNotice')}</div>
            {progressPanel(progress, t, true)}
            <div className="actions">
              <button className="primary" disabled={downloading || !sabrVideoItag || !sabrAudioItag} onClick={() => void startSabrDownload()}>
                {downloading ? t('downloadingEllipsis') : t('chooseFileDownload')}
              </button>
              {downloading && <button className="secondary" onClick={() => abortController.current?.abort()}>{t('cancel')}</button>}
            </div>
          </>
        )}

        {hls && (
          <>
            <div className="facts">
              <div><span>{t('protocol')}</span><strong>HLS</strong></div>
              <div><span>{t('segments')}</span><strong>{combinedHlsMediaPlaylist(hls).segments.length}</strong></div>
              <div><span>{t('duration')}</span><strong>{Math.round(hls.media.segments.reduce((sum, segment) => sum + segment.duration, 0))}s</strong></div>
              <div><span>{t('playlist')}</span><strong>{hls.media.endList ? 'VOD' : t('live')}</strong></div>
            </div>

            {hls.master?.variants.some((variant) => variant.resolution) && (
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

            {progressPanel(progress, t)}

            <div className="actions">
              <button
                className="primary"
                disabled={downloading || problems.length > 0}
                onClick={() => void startHlsDownload()}
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
              <div><span>{t('tracks')}</span><strong>{dash.tracks.length}</strong></div>
              <div><span>{t('protection')}</span><strong>{dash.hasContentProtection ? t('detected') : t('noneDetected')}</strong></div>
            </div>

            {videoQualities.length > 0 && <label className="resolution-field">
              {t('resolution')}
              <select
                value={dashVideoId}
                disabled={downloading}
                onChange={(event) => setDashVideoId(event.target.value)}
              >
                {videoQualities.map((quality, index) => (
                  <option value={quality.id} key={quality.id}>{videoQualityLabel(quality)}{index === 0 ? ` · ${t('highestAvailable')}` : ''}</option>
                ))}
              </select>
            </label>}

            <label>
              {t('audioTrack')}
              <select
                value={dashAudioId}
                disabled={downloading}
                onChange={(event) => setDashAudioId(event.target.value)}
              >
                {dashAudioTracks.map((track) => (
                  <option value={track.id} key={track.id}>{dashTrackLabel(track, t)}</option>
                ))}
              </select>
            </label>

            <label>
              {t('outputFormat')}
              <select value="mp4" disabled>
                <option value="mp4">{t('mp4RecommendedNoReencode')}</option>
              </select>
            </label>

            <div className="notice info">
              {t('dashMuxNotice')}
            </div>
            {dashProblems.map((problem) => <div className="notice warning" key={problem}>{problem}</div>)}

            {progressPanel(progress, t)}

            <div className="actions">
              <button
                className="primary"
                disabled={downloading || dashProblems.length > 0 || !dashVideoId || !dashAudioId}
                onClick={() => void startDashDownload()}
              >
                {downloading ? t('downloadingEllipsis') : t('chooseFileDownload')}
              </button>
              {downloading && (
                <button className="secondary" onClick={() => abortController.current?.abort()}>{t('cancel')}</button>
              )}
            </div>
          </>
        )}
        </section>
        <p className="footnote">{t('mediaPermissionFootnote')}</p>
      </main>
    </>
  );
}
