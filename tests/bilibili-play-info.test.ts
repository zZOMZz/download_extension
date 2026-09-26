import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseBilibiliPlaybackInfoResponse,
  parseBilibiliPlaybackInfoScript,
  parseBilibiliPlayInfoResponse,
  parseBilibiliPlayInfoScript,
} from '../src/core/site-adapters/bilibili/play-info';

// Whitelisted fields from ep3854817 responses; all URLs are synthetic and account data is removed.
const fullJson = readFileSync(new URL('./fixtures/bilibili-bangumi-full.json', import.meta.url), 'utf8');
const previewJson = readFileSync(new URL('./fixtures/bilibili-bangumi-preview.json', import.meta.url), 'utf8');
const full = () => JSON.parse(fullJson);
const preview = () => JSON.parse(previewJson);

describe('Bilibili playback metadata', () => {
  it('reads the observed bangumi data/result/video_info envelope and episode identity', () => {
    const info = parseBilibiliPlaybackInfoResponse(fullJson);
    expect(info).toMatchObject({
      isPreview: false,
      hasContentProtection: false,
      episodeId: 3854817,
      cid: 42162064891,
      durationSeconds: 1711,
      dash: { type: 'static', hasContentProtection: false },
    });
    expect(info?.dash?.tracks.filter(({ kind }) => kind === 'video')).toHaveLength(4);
    expect(info?.dash?.tracks.some(({ kind }) => kind === 'audio')).toBe(true);
    expect(info?.progressiveUrl).toBeUndefined();
  });

  it.each(['data', 'result', 'video_info'])('reads a direct %s wrapper and raw video info', (key) => {
    const video = full().data.result.video_info;
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify({ [key]: video }))?.dash).toBeDefined();
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify(video))?.dash).toBeDefined();
  });

  it('reads literal SSR data without trying to execute the following property assignment', () => {
    const script = `const playurlSSRData = ${JSON.stringify({ status: 200, ...full() })};
      window.__playinfo__ = playurlSSRData.data;`;
    expect(parseBilibiliPlaybackInfoScript(script)).toEqual(parseBilibiliPlaybackInfoResponse(fullJson));
    expect(parseBilibiliPlayInfoScript(script)).toEqual(parseBilibiliPlayInfoResponse(fullJson));
  });

  it('continues to read direct legacy assignments and handles escaped braces inside JSON strings', () => {
    const payload = { data: full().data.result.video_info, title: 'a } brace and a " quote' };
    for (const name of ['window.__playinfo__', '__playinfo__']) {
      expect(parseBilibiliPlayInfoScript(`${name}=${JSON.stringify(payload)};`)).toBeDefined();
    }
  });

  it('uses literal SSR player config as an episode identity fallback without evaluating Object.assign', () => {
    const payload = full();
    delete payload.data.result.video_info.support_formats;
    for (const key of ['episodeId', 'ep_id']) {
      const script = `var config = {}; config = Object.assign(config, {"${key}":3854817}, functionConfig);
        const playurlSSRData = ${JSON.stringify(payload)}; window.__playinfo__ = playurlSSRData.data;`;
      expect(parseBilibiliPlaybackInfoScript(script)?.episodeId).toBe(3854817);
    }
    const script = `config = Object.assign(config, {"episodeId":1}, functionConfig);
      const playurlSSRData = ${fullJson};`;
    expect(parseBilibiliPlaybackInfoScript(script)?.episodeId).toBe(3854817);
    expect(parseBilibiliPlaybackInfoScript('config = Object.assign(config, {"episodeId":3854817}, functionConfig);'))
      .toBeUndefined();
  });

  it('ignores nonliteral expressions, comments, strings, and similarly named properties', () => {
    const json = fullJson.replaceAll('\n', '');
    expect(parseBilibiliPlaybackInfoScript(`window.__playinfo__ = load(); const unrelated = ${json};`)).toBeUndefined();
    expect(parseBilibiliPlaybackInfoScript(`window.__playinfo__ = JSON.parse(${JSON.stringify(json)});`)).toBeUndefined();
    expect(parseBilibiliPlaybackInfoScript(`/*\nwindow.__playinfo__ = ${json};\n*/`)).toBeUndefined();
    expect(parseBilibiliPlaybackInfoScript(`// window.__playinfo__ = ${json};`)).toBeUndefined();
    expect(parseBilibiliPlaybackInfoScript(`const text = ${JSON.stringify(`window.__playinfo__ = ${json};`)};`)).toBeUndefined();
    expect(parseBilibiliPlaybackInfoScript(`other.__playinfo__ = ${json};`)).toBeUndefined();
    expect(parseBilibiliPlaybackInfoScript(`window.__playinfo__ = {data: sideEffect()};`)).toBeUndefined();
  });

  it('marks an anonymous preview and uses its actual file duration instead of the episode timelength', () => {
    expect(parseBilibiliPlaybackInfoResponse(previewJson)).toMatchObject({
      isPreview: true,
      hasContentProtection: false,
      progressiveUrl: 'https://media.example/preview.mp4',
      episodeId: 3854817,
      durationSeconds: 180.16,
    });
    const payload = preview();
    delete payload.data.result.video_info.is_preview;
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify(payload))?.isPreview).toBe(true);
    delete payload.data.result.video_info.durl[0].length;
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify(payload))?.durationSeconds).toBeUndefined();
  });

  it('keeps a preview DASH from being returned through the legacy full-video parser', () => {
    const payload = full();
    payload.data.result.video_info.is_preview = true;
    const json = JSON.stringify(payload);
    expect(parseBilibiliPlaybackInfoResponse(json)).toMatchObject({ isPreview: true, dash: { type: 'static' } });
    expect(parseBilibiliPlayInfoResponse(json)).toBeUndefined();
    expect(parseBilibiliPlayInfoScript(`window.__playinfo__=${json};`)).toBeUndefined();
  });

  it.each([null, false, 0, '0', 'false'])('does not classify is_drm=%s as protection', (value) => {
    const payload = full();
    payload.data.result.video_info.is_drm = value;
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify(payload))?.hasContentProtection).toBe(false);
  });

  it.each([true, 1, '1'])('propagates is_drm=%s to the DASH source', (value) => {
    const payload = full();
    payload.data.result.video_info.is_drm = value;
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify(payload))).toMatchObject({
      hasContentProtection: true,
      dash: { hasContentProtection: true },
    });
  });

  it('detects protection on wrappers, DASH metadata, and individual tracks', () => {
    for (const location of ['wrapper', 'dash', 'track']) {
      const payload = full();
      if (location === 'wrapper') payload.data.result.drm_tech_type = 2;
      if (location === 'dash') payload.data.result.video_info.dash.ContentProtection = [{ schemeIdUri: 'urn:uuid:test' }];
      if (location === 'track') payload.data.result.video_info.dash.video[0].drm_info = { pssh: 'test' };
      expect(parseBilibiliPlaybackInfoResponse(JSON.stringify(payload))?.dash?.hasContentProtection).toBe(true);
    }
    const payload = preview();
    payload.data.result.video_info.is_drm = true;
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify(payload))).toMatchObject({ hasContentProtection: true });
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify(payload))?.progressiveUrl).toBeUndefined();
    expect(parseBilibiliPlaybackInfoResponse('{"data":{"video_info":{"is_drm":true}}}'))
      .toEqual({ hasContentProtection: true, isPreview: false });
  });

  it('assigns stable distinct IDs to encodings sharing a quality while preserving unambiguous IDs', () => {
    const first = parseBilibiliPlayInfoResponse(fullJson)!.tracks;
    expect(new Set(first.map(({ id }) => id)).size).toBe(first.length);
    expect(first.find(({ codecs }) => codecs === 'hvc1.2.4.L153.90')?.id).toBe('125');
    const changed = full();
    changed.data.result.video_info.dash.video.reverse();
    for (const track of changed.data.result.video_info.dash.video) {
      track.base_url = track.base_url.replace('media.example', 'refreshed.example') + '?new=signature';
    }
    const second = parseBilibiliPlayInfoResponse(JSON.stringify(changed))!.tracks;
    const identities = (tracks: typeof first) => tracks.map(({ id, codecs }) => `${id}:${codecs}`).sort();
    expect(identities(first)).toEqual(identities(second));
  });

  it('coalesces duplicate encodings while keeping alternative URLs', () => {
    const payload = full();
    const video = payload.data.result.video_info.dash.video;
    video.push({ ...video[0], base_url: 'https://third.example/duplicate.m4s' });
    const tracks = parseBilibiliPlayInfoResponse(JSON.stringify(payload))!.tracks;
    expect(new Set(tracks.map(({ id }) => id)).size).toBe(tracks.length);
    expect(tracks.filter(({ kind }) => kind === 'video')).toHaveLength(4);
    expect(tracks.find(({ codecs }) => codecs === video[0].codecs)?.id).toBe('125');
    expect(tracks.find(({ codecs }) => codecs === video[0].codecs)?.initialization.alternativeUrls)
      .toContain('https://third.example/duplicate.m4s');
  });

  it('does not offer a single file for multi-file durl, FLV, or unsafe URLs', () => {
    const payload = preview();
    const video = payload.data.result.video_info;
    video.durl.push({ ...video.durl[0], url: 'https://media.example/part-two.mp4' });
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify(payload))?.progressiveUrl).toBeUndefined();
    video.durl.pop();
    video.format = 'flv';
    video.durl[0].url = 'https://media.example/movie.flv';
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify(payload))?.progressiveUrl).toBeUndefined();
    video.format = 'mp4';
    video.durl[0].url = 'javascript:sideEffect()';
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify(payload))?.progressiveUrl).toBeUndefined();
  });

  it('ignores unsuccessful, malformed, unsupported, and deeply wrapped responses', () => {
    expect(parseBilibiliPlaybackInfoResponse('not JSON')).toBeUndefined();
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify({ code: -10403, ...full() }))).toBeUndefined();
    expect(parseBilibiliPlaybackInfoResponse('{"data":{"dash":{}}}')).toBeUndefined();
    let nested = full();
    for (let index = 0; index < 10; index += 1) nested = { data: nested };
    expect(parseBilibiliPlaybackInfoResponse(JSON.stringify(nested))).toBeUndefined();
  });

  it('ignores unsafe or incomplete byte ranges without throwing from script parsing', () => {
    const payload = full();
    const dash = payload.data.result.video_info.dash;
    dash.audio = [];
    for (const track of dash.video) track.segment_base.initialization = '0-9007199254740991';
    expect(parseBilibiliPlaybackInfoScript(`window.__playinfo__=${JSON.stringify(payload)};`)).toBeUndefined();
  });
});
