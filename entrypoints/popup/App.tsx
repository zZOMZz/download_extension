import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { displayUrl, formatBytes } from '~/src/core/format';
import { candidateVideoQualities, selectedVideoQuality, videoQualityLabel } from '~/src/core/media-quality';
import { visibleMediaCandidates } from '~/src/core/detection/present-candidates';
import { supportsSiteDiscovery } from '~/src/core/discovery/registry';
import { listTabCandidates, runRuntimeAction } from '~/src/browser/runtime-client';
import { readSettings, setOutputFormat } from '~/src/browser/settings';
import { createTranslator, type MessageKey } from '~/src/shared/i18n';
import type { MediaCandidate } from '~/src/shared/media';
import { outputFormatSchema, type AppLanguage, type OutputFormat } from '~/src/shared/settings';
import { BrandMark } from '~/src/components/brand-mark';

const KIND_LABEL_KEYS: Record<MediaCandidate['kind'], MessageKey> = {
  progressive: 'kindProgressive',
  hls: 'kindHls',
  dash: 'kindDash',
  sabr: 'kindSabr',
  blob: 'kindBlob',
};

export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<MediaCandidate[]>([]);
  const visibleCandidates = useMemo(() => visibleMediaCandidates(candidates), [candidates]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [outputFormat, setOutputFormatState] = useState<OutputFormat>('mp4');
  const [supportsBatchDiscovery, setSupportsBatchDiscovery] = useState(false);
  const [selectedQualities, setSelectedQualities] = useState<Record<string, string>>({});
  const t = useMemo(() => createTranslator(language), [language]);

  const refresh = useCallback(async (explicitTabId?: number) => {
    try {
      const resolvedTabId = explicitTabId ?? tabId;
      if (resolvedTabId === null) return;
      setCandidates(await listTabCandidates(resolvedTabId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('unableReadMedia'));
    } finally {
      setLoading(false);
    }
  }, [t, tabId]);

  useEffect(() => {
    void readSettings().then((settings) => {
      setLanguage(settings.language);
      setOutputFormatState(settings.outputFormat);
    });
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t('appName');
  }, [language, t]);

  useEffect(() => {
    void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id === undefined) {
        setError(t('noActiveTab'));
        setLoading(false);
        return;
      }
      setTabId(tab.id);
      setSupportsBatchDiscovery(Boolean(tab.url && supportsSiteDiscovery(tab.url)));
      void refresh(tab.id);
    });
  }, [refresh, t]);

  useEffect(() => {
    if (tabId === null) return undefined;
    const key = `media-candidates:${tabId}`;
    const listener = (changes: Record<string, Browser.storage.StorageChange>, area: string) => {
      if (area === 'session' && key in changes) void refresh(tabId);
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [refresh, tabId]);

  const act = async (candidate: MediaCandidate) => {
    try {
      setError(null);
      if (candidate.kind === 'progressive' && !candidate.siteAdapterId) {
        await runRuntimeAction({
          type: 'download:direct',
          tabId: candidate.tabId,
          candidateId: candidate.id,
        });
      } else {
        const videoTrackId = selectedVideoQuality(candidateVideoQualities(candidate), selectedQualities[candidate.id]);
        await runRuntimeAction({
          type: 'downloader:open',
          tabId: candidate.tabId,
          candidateId: candidate.id,
          ...(videoTrackId ? { videoTrackId } : {}),
        });
        window.close();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('actionFailed'));
    }
  };

  const clear = async () => {
    if (tabId === null) return;
    await runRuntimeAction({ type: 'candidate:clear', tabId });
    setCandidates([]);
  };

  const changeOutputFormat = async (value: string) => {
    const format = outputFormatSchema.parse(value);
    setOutputFormatState(format);
    try {
      await setOutputFormat(format);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('unableSaveOutput'));
    }
  };

  const openManager = async () => {
    try {
      setError(null);
      await runRuntimeAction({
        type: 'manager:open',
        ...(supportsBatchDiscovery && tabId !== null ? { tabId } : {}),
      });
      window.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('unableOpenManager'));
    }
  };

  return (
    <main>
      <header className="popup-header">
        <BrandMark compact />
        {visibleCandidates.length > 0 && <button className="quiet" onClick={() => void clear()}>{t('clear')}</button>}
      </header>

      <div className="popup-intro">
        <p className="eyebrow">{t('authorizedMediaOnly')}</p>
        <h1>{t('mediaFound')}</h1>
      </div>

      {error && <div className="notice error">{error}</div>}
      {loading && <div className="empty">{t('scanningPage')}</div>}
      {!loading && visibleCandidates.length === 0 && (
        <div className="empty">
          <strong>{t('noMediaDetected')}</strong>
          <span>{t('startPlaybackHint')}</span>
        </div>
      )}

      <section className="candidate-list">
        {visibleCandidates.map((candidate) => {
          const protectedMedia = candidate.hasContentProtection || candidate.dash?.hasContentProtection;
          const disabled = candidate.kind === 'blob' || protectedMedia;
          const qualities = candidateVideoQualities(candidate);
          const selectedQuality = selectedVideoQuality(qualities, selectedQualities[candidate.id]);
          const displayedQuality = qualities.find(({ id }) => id === selectedQuality);
          return (
            <article className="candidate" key={candidate.id}>
              {candidate.thumbnailUrl && <div className="candidate-cover">
                <img src={candidate.thumbnailUrl} alt={t('videoThumbnail')} loading="lazy" referrerPolicy="no-referrer" />
                {displayedQuality && <span className="cover-quality">{videoQualityLabel(displayedQuality)}</span>}
              </div>}
              <div className="candidate-body">
              <div className="candidate-heading">
                <span className={`kind kind-${candidate.kind}`}>{t(KIND_LABEL_KEYS[candidate.kind])}</span>
                {formatBytes(candidate.contentLength) && <span>{formatBytes(candidate.contentLength)}</span>}
              </div>
              <h2 className="candidate-title">{candidate.title || (candidate.kind === 'blob' ? t('pageGeneratedBlob') : displayUrl(candidate.sourcePageUrl ?? candidate.url))}</h2>
              {candidate.browserSource && <p className="notice info">{t('browserSourceHint')}</p>}
              {candidate.isPreview && <p className="notice info">{t('previewOnly')}</p>}
              {protectedMedia && <p className="notice error">{t('protectedMediaUnsupported')}</p>}
              {qualities.length > 0 && <label className="quality-picker">
                <span>{t('resolution')}</span>
                <select value={selectedQuality} onChange={(event) => setSelectedQualities((current) => ({ ...current, [candidate.id]: event.target.value }))}>
                  {qualities.map((quality, index) => <option key={quality.id} value={quality.id}>
                    {videoQualityLabel(quality)}{index === 0 ? ` · ${t('highestAvailable')}` : ''}
                  </option>)}
                </select>
              </label>}
              <button disabled={disabled} onClick={() => void act(candidate)}>
                {protectedMedia ? t('protectedMediaLabel') : disabled ? t('notExportableYet') : candidate.isPreview ? t('downloadPreview') : t('download')}
              </button>
              </div>
            </article>
          );
        })}
      </section>

      <section className="batch-entry">
        <div><strong>{supportsBatchDiscovery ? t('seriesDiscoveryAvailable') : t('downloadQueue')}</strong></div>
        <button className="quiet" onClick={() => void openManager()}>
          {supportsBatchDiscovery ? t('scanBatchDownload') : t('openManager')}
        </button>
      </section>

      <label className="output-setting">
        <span>{t('streamOutput')}</span>
        <select value={outputFormat} onChange={(event) => void changeOutputFormat(event.target.value)}>
          <option value="mp4">{t('mp4Recommended')}</option>
          <option value="original">{t('originalStreamFormat')}</option>
        </select>
      </label>
    </main>
  );
}
