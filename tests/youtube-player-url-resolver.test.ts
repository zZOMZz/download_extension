import { describe, expect, it } from 'vitest';
import {
  findYouTubePlayerUrlConstructorName,
  resolveYouTubePlayerUrl,
} from '../src/core/site-adapters/youtube/player-url-resolver';

// Structural excerpts from the ES6 and legacy player bundles; no bundle is executed.
const es6Source = 'KI=function(f,k="",G=""){f=new g.A3(f,!0);f.set("alr","yes");return f};';
const legacySource = 'BH=function(f,k,G){k=k===void 0?"":k;G=G===void 0?"":G;' +
  'f=new g.ZO(f,!0);f.set("alr","yes");return f};';
const rawUrl = 'https://rr1---sn-test.googlevideo.com/videoplayback' +
  '?id=video-resource&itag=18&n=raw-token&sparams=id%2Citag&sig=a%2bb%3D&foo=one+two';

class LoadedPlayerUrl {
  readonly url: string;
  readonly transform: boolean;

  constructor(url: string, transform: boolean) {
    this.url = url;
    this.transform = transform;
  }

  get(name: string): string | null {
    if (name === 'n' && this.transform) return 'resolved%2Btoken';
    return new URL(this.url).searchParams.get(name);
  }

  set(): void {}
  clone(): LoadedPlayerUrl { return new LoadedPlayerUrl(this.url, this.transform); }
}

describe('YouTube loaded player URL resolver', () => {
  it('discovers different constructor exports in ES6 and legacy player builds', () => {
    expect(findYouTubePlayerUrlConstructorName(es6Source)).toBe('A3');
    expect(findYouTubePlayerUrlConstructorName(legacySource)).toBe('ZO');
    expect(findYouTubePlayerUrlConstructorName(es6Source.replaceAll('A3', '$nextBuild'))).toBe('$nextBuild');
    expect(findYouTubePlayerUrlConstructorName('f=new g.Unrelated(f,!0);f.set("other","yes")')).toBeUndefined();
  });

  it('uses the already loaded constructor and preserves every query byte except n', () => {
    expect(resolveYouTubePlayerUrl(rawUrl, { A3: LoadedPlayerUrl }, es6Source))
      .toBe(rawUrl.replace('n=raw-token', 'n=resolved%2Btoken'));
  });

  it('does not require player code for URLs without n', () => {
    const url = rawUrl.replace('&n=raw-token', '');
    expect(resolveYouTubePlayerUrl(url, undefined, '')).toBe(url);
  });

  it.each([
    rawUrl.replace('sparams=id%2Citag', 'sparams=id%2Citag%2Cn'),
    `${rawUrl}&lsparams=n`,
    `${rawUrl}&n=another-token`,
    rawUrl.replace('n=raw-token', 'n='),
    rawUrl.replace('https:', 'http:'),
    rawUrl.replace('googlevideo.com', 'googlevideo.com.evil.example'),
    rawUrl.replace('/videoplayback', '/other'),
  ])('rejects URLs that cannot safely use an n transformation: %s', (url) => {
    expect(resolveYouTubePlayerUrl(url, { A3: LoadedPlayerUrl }, es6Source)).toBeUndefined();
  });

  it('fails closed when the source and loaded namespace do not match', () => {
    expect(resolveYouTubePlayerUrl(rawUrl, { ZO: LoadedPlayerUrl }, es6Source)).toBeUndefined();
    expect(resolveYouTubePlayerUrl(rawUrl, { A3: LoadedPlayerUrl }, '')).toBeUndefined();
    expect(resolveYouTubePlayerUrl(rawUrl, { A3: {} }, es6Source)).toBeUndefined();
  });

  it.each(['raw-token', 'enhanced_except_failed', '%invalid', ''])(
    'rejects failed or unchanged player output: %s',
    (output) => {
      class FailedPlayerUrl {
        get(): string { return output; }
        set(): void {}
        clone(): FailedPlayerUrl { return this; }
      }
      expect(resolveYouTubePlayerUrl(rawUrl, { A3: FailedPlayerUrl }, es6Source)).toBeUndefined();
    },
  );

  it('contains errors thrown by a changed player implementation', () => {
    class ThrowingPlayerUrl {
      get(): never { throw new Error('Player implementation changed'); }
      set(): void {}
      clone(): ThrowingPlayerUrl { return this; }
    }
    expect(resolveYouTubePlayerUrl(rawUrl, { A3: ThrowingPlayerUrl }, es6Source)).toBeUndefined();
  });
});
