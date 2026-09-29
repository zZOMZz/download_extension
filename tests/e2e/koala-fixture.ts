import { createCipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from '@playwright/test';

const SDK_URL = 'https://g.alicdn.com/apsara-media-box/imp-web-player/2.37.0/hls/aliplayer-hls2-min.js';
const SDK_SHA256 = '5de2506269a03c0a418f431021d774857a8698a9703e7597aa84c515ded16e36';
const KEY = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
export const KOALA_IDS = ['a38d4ed3-873b-4110-bf51-02f3a6319f2c', 'dc1a89b5-854c-4566-9090-ecdb551a70bb'];
export const koalaFixtureUrl = (index = 0) => `https://app.koala-oss.club/videos/${KOALA_IDS[index]}`;

async function sdk(): Promise<Buffer> {
  const cache = process.env.ALIPLAYER_TEST_SDK ?? join(tmpdir(), 'open-media-downloader-aliplayer-2.37.0.js');
  let bytes: Buffer;
  try { bytes = await readFile(cache); }
  catch {
    const response = await fetch(SDK_URL);
    if (!response.ok) throw Error('Unable to download the pinned public Aliplayer test SDK.');
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== SDK_SHA256) throw Error('Aliplayer fixture SDK hash mismatch.');
    await writeFile(cache, bytes);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== SDK_SHA256) throw Error('Aliplayer fixture SDK hash mismatch.');
  return bytes;
}

function encryptFixture(bytes: Uint8Array): Uint8Array {
  const streams = new Map<number, number[]>();
  const finish = (positions: number[]) => {
    const pes = Uint8Array.from(positions, position => bytes[position]!);
    if (pes.length < 10 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 ||
        !((pes[3]! >= 0xc0 && pes[3]! <= 0xef) || pes[3] === 0xbd)) return;
    const header = 9 + pes[8]!, length = Math.floor((pes.length - header) / 16) * 16;
    if (length <= 0) return;
    const cipher = createCipheriv('aes-128-ecb', KEY, null); cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(pes.subarray(header, header + length)), cipher.final()]);
    encrypted.forEach((value, index) => { bytes[positions[header + index]!] = value; });
  };
  for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
    if (bytes[offset] !== 0x47) throw Error('Invalid test transport stream.');
    const pid = ((bytes[offset + 1]! & 31) << 8) | bytes[offset + 2]!, control = (bytes[offset + 3]! >> 4) & 3;
    if (!(control & 1)) continue;
    const start = offset + 4 + (control & 2 ? 1 + bytes[offset + 4]! : 0);
    if (bytes[offset + 1]! & 0x40) { if (streams.has(pid)) finish(streams.get(pid)!); streams.set(pid, []); }
    const positions = streams.get(pid);
    if (positions) for (let index = start; index < offset + 188; index++) positions.push(index);
  }
  for (const positions of streams.values()) finish(positions);
  return bytes;
}

export async function installKoalaFixture(context: BrowserContext, options: { coldStart?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'koala-extension-fixture-'));
  const source = await sdk();
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100',
    '-t', '16', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '96k', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
    '-hls_segment_filename', join(root, 'segment-%03d.bin'), join(root, 'index.m3u8')]);
  const manifest = await readFile(join(root, 'index.m3u8'), 'utf8');
  const media = new Map<string, Uint8Array>();
  for (const line of manifest.split('\n').filter(line => line.endsWith('.bin'))) media.set(line, encryptFixture(new Uint8Array(await readFile(join(root, line)))));
  const requests: string[] = [];
  let revision = 0, hold = false;
  let release = () => {};
  let gate = Promise.resolve();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'app.koala-oss.club') {
      if (url.pathname === '/sdk.js') return route.fulfill({ contentType: 'text/javascript', body: source });
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Koala fixture</title><h1>Videos</h1>${KOALA_IDS.map((id, index) => `<a href="/videos/${id}"><h3>Koala video ${index + 1}</h3></a>`).join('')}` });
      const index = KOALA_IDS.indexOf(url.pathname.split('/').at(-1)!);
      if (index < 0) return route.fulfill({ status: 404, body: 'Not found' });
      const token = ++revision;
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Koala video ${index + 1}</title>
        <h1>Koala video ${index + 1}</h1><video id="player" controls muted></video><script src="/sdk.js"></script>
        <script>const video=document.querySelector('video');video.dataset.playEvents='0';
        video.addEventListener('play',()=>video.dataset.playEvents=String(Number(video.dataset.playEvents)+1));
        const source='https://koala-media.example/${KOALA_IDS[index]}/index.m3u8?signature=${token}';
        const player=video.player={tag:video,_isHls:true,_options:{source,autoplay:false},_hls:null,
          initPlay(){if(this._hls)return;const hls=this._hls=new AliHls({autoStartLoad:${!options.coldStart},enableWorker:${index === 1},maxBufferLength:2,maxMaxBufferLength:2,maxBufferSize:65536,_vpk:${JSON.stringify(Array.from(KEY))}});
          ${options.coldStart ? '' : 'hls.loadSource(source);'}hls.attachMedia(video);}};
        ${options.coldStart && index === 1 ? '' : 'player.initPlay();'}</script>` });
    }
    if (url.hostname === 'koala-media.example') {
      requests.push(url.pathname);
      const name = url.pathname.split('/').at(-1)!;
      const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
      if (name === 'index.m3u8') return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', headers,
        body: manifest.replace(/\.bin\n/g, `.bin?signature=${url.searchParams.get('signature')}\n`) });
      const bytes = media.get(name);
      if (!bytes) return route.fulfill({ status: 404, headers, body: 'Not found' });
      if (hold && name === 'segment-004.bin') await gate;
      try { return await route.fulfill({ contentType: 'video/mp2t', headers, body: Buffer.from(bytes) }); }
      catch { return; /* A source page can close while this response is intentionally held. */ }
    }
    return route.fallback();
  });
  return {
    requests,
    holdFifthSegment() { hold = true; gate = new Promise<void>(resolve => { release = resolve; }); },
    release() { hold = false; release(); },
    async close() { hold = false; release(); await rm(root, { recursive: true, force: true }); },
  };
}
