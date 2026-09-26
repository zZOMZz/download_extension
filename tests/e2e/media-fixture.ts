import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import muxjs from 'mux.js';
import type { BrowserContext } from '@playwright/test';

export async function createMediaFixture() {
  const ts = await readFile('node_modules/mux.js/test/segments/test-segment.ts');
  const chunks: Buffer[] = [];
  const transmuxer = new muxjs.mp4.Transmuxer();
  transmuxer.on('data', (segment) => chunks.push(Buffer.from(segment.initSegment), Buffer.from(segment.data)));
  const done = new Promise<void>((resolve) => transmuxer.on('done', resolve));
  transmuxer.push(ts);
  transmuxer.flush();
  await done;
  const mp4 = Buffer.concat(chunks);
  const requests: string[] = [];
  const held = new Set<ServerResponse>();
  let holdSecond = false;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    requests.push(path);
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (path === '/source.html') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>E2E HLS sample</title><h1>Authorized local HLS fixture</h1><video src="/single.m3u8"></video><script>fetch("/single.m3u8")</script>');
    } else if (path.endsWith('.m3u8')) {
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const segments = path === '/resume.m3u8'
        ? ['first.ts', 'held.ts'] : [path === '/episode-two.m3u8' ? 'episode-two.ts' : 'single.ts'];
      response.end(`#EXTM3U\n#EXT-X-TARGETDURATION:10\n${segments.map((name) => `#EXTINF:10,\n${name}\n`).join('')}#EXT-X-ENDLIST`);
    } else if (path.endsWith('.ts')) {
      response.setHeader('Content-Type', 'video/mp2t');
      response.setHeader('Content-Length', ts.length);
      if (path === '/held.ts' && holdSecond) {
        held.add(response);
        response.once('close', () => held.delete(response));
      } else response.end(ts);
    } else if (path === '/progressive.mp4') {
      response.setHeader('Content-Type', 'video/mp4');
      response.setHeader('Content-Length', mp4.length);
      response.end(mp4);
    } else response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind TCP.');
  const origin = `http://127.0.0.1:${address.port}`;
  const seriesUrl = 'https://www.2rk.cc/detail/e2e';
  const bilibiliUrl = 'https://www.bilibili.com/bangumi/play/ep99001';
  const playback = { code: 0, result: { video_info: {
    cid: 88001, ep_id: 99001, format: 'mp4', timelength: 9_000,
    durl: [{ order: 1, length: 9_000, size: mp4.length, url: `${origin}/progressive.mp4` }],
  } } };
  const bilibiliPage = `<!doctype html><title>E2E Bilibili progressive</title><h1>Authorized PGC fixture</h1>
    <script>window.playurlSSRData = ${JSON.stringify(playback)};</script>`;

  return {
    origin, seriesUrl, bilibiliUrl, requests, tsBytes: ts.length, mp4Bytes: mp4.length,
    holdSecondSegment() { holdSecond = true; },
    releaseSecondSegment() {
      holdSecond = false;
      for (const response of held) if (!response.destroyed) response.end(ts);
      held.clear();
    },
    async installRoutes(context: BrowserContext) {
      // Only site HTML/API material is fulfilled; media transfers use a real HTTP server.
      // No real account requests leave this isolated browser profile.
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin || url.protocol === 'chrome-extension:') return route.continue();
        if (url.hostname === 'www.2rk.cc') {
          const number = url.searchParams.get('id') ?? '1';
          const manifest = number === '2' ? 'episode-two.m3u8' : 'resume.m3u8';
          return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>E2E Series</title>
            <h2>E2E Series</h2><a href="/detail/e2e?id=1">Episode 1</a><a href="/detail/e2e?id=2">Episode 2</a>
            <script type="application/json">hls.loadSource("${origin}/${manifest}")</script>` });
        }
        if (url.hostname === 'www.bilibili.com') {
          return route.fulfill({ contentType: 'text/html', body: bilibiliPage });
        }
        if (url.hostname === 'api.bilibili.com' && url.pathname === '/pgc/view/web/season') {
          return route.fulfill({ contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': 'https://www.bilibili.com', 'Access-Control-Allow-Credentials': 'true' },
            body: JSON.stringify({ code: 0, result: { season_id: 77001, title: 'E2E Bilibili',
              episodes: [{ id: 99001, cid: 88001, title: '1', long_title: 'Progressive MP4' }] } }) });
        }
        return route.abort('blockedbyclient');
      });
    },
    async close() {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export type MediaFixture = Awaited<ReturnType<typeof createMediaFixture>>;
