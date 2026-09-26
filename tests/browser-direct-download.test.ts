import { describe, expect, it, vi } from 'vitest';
const session = vi.hoisted(() => vi.fn());
vi.mock('../src/browser/runtime-client', () => ({ getYouTubeSabrContext: session }));
import { describeBrowserDirectOutput, runBrowserDirectDownload } from '../src/browser/direct-download';
import type { DirectOutputTarget, DirectMediaSelection } from '../src/runtime/direct-download';

function output(): DirectOutputTarget {
  return {
    resumable: false,
    writer: { write: vi.fn(), writeAt: vi.fn(), close: vi.fn(), abort: vi.fn() },
    read: vi.fn(), finish: vi.fn(), abort: vi.fn(async () => {}),
  };
}
const source: Extract<DirectMediaSelection, { kind: 'sabr' }> = {
  kind: 'sabr', videoItag: 1, audioItag: 2,
  source: { videoId: 'fixture', durationSeconds: 1, formats: [], serverAbrStreamingUrl: 'https://rr1.googlevideo.com/videoplayback' },
};

describe('browser direct download lifecycle bridge', () => {
  it('waits for the picker, then aborts its target if the user cancelled while it was open', async () => {
    session.mockReset();
    let selected!: (target: DirectOutputTarget) => void;
    const pendingTarget = new Promise<DirectOutputTarget>((resolve) => { selected = resolve; });
    const controller = new AbortController();
    const target = output();
    const pending = expect(runBrowserDirectDownload(source, pendingTarget, {
      sourceTabId: 5, candidateId: 'candidate', signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(session).not.toHaveBeenCalled();
    controller.abort();
    selected(target);
    await pending;
    expect(session).not.toHaveBeenCalled();
    expect(target.abort).toHaveBeenCalledOnce();
    expect(target.writer.write).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after looking up the source tab SABR session', async () => {
    const controller = new AbortController();
    const target = output();
    session.mockReset().mockImplementation(async () => {
      controller.abort();
      return { serverAbrStreamingUrl: source.source.serverAbrStreamingUrl, videoPlaybackUstreamerConfig: 'AQID' };
    });
    await expect(runBrowserDirectDownload(source, Promise.resolve(target), {
      sourceTabId: 7, candidateId: 'session-candidate', signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(session).toHaveBeenCalledWith(7, 'session-candidate');
    expect(target.abort).toHaveBeenCalledOnce();
    expect(target.writer.write).not.toHaveBeenCalled();
  });
});


describe('Bilibili direct output compatibility', () => {
  it('marks preview files and preserves the native-file requirement for progressive video', () => {
    expect(describeBrowserDirectOutput({ kind: 'progressive', url: 'https://media.example/video.mp4' }, {
      title: 'Episode 1', isPreview: true,
    })).toMatchObject({ filename: 'Episode 1-preview.mp4', allowMemoryFallback: false });
    expect(describeBrowserDirectOutput({ kind: 'dash', videoTrackId: 'v', source: {
      type: 'static', hasContentProtection: false,
      tracks: [{ id: 'v', kind: 'video', mimeType: 'video/mp4', height: 1080,
        initialization: { url: 'https://media.example/video.mp4' } }],
    } }, { title: 'Episode 1', isPreview: true }).filename).toBe('Episode 1-1080p-preview.mp4');
    expect(describeBrowserDirectOutput({ kind: 'progressive', url: 'https://media.example/video.mp4' }, {
      title: 'Episode 1', isPreview: false,
    }).filename).toBe('Episode 1.mp4');
  });
});
