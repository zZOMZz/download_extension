import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import muxjs from 'mux.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeHost, NodeArtifactStore, NodeExecutionLocks, createNodeTransport } from '../src/hosts/node';
import { readMediaArtifact } from '../src/runtime/artifact-store';
import { validateMediaOutput } from '../src/core/media/output-validator';
import { NETWORK_PRESETS } from '../src/shared/settings';
import type { DownloadTask } from '../src/shared/download-task';

const temporaryDirectories: string[] = [];
const testNetwork = { ...NETWORK_PRESETS.balanced, maxAttempts: 1, taskRecoveryAttempts: 0 };
const transportStream = new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts'));
const requests: string[] = [];
const resources = new Map<string, string | Uint8Array>();
let failSecondSegment = false;
let server: Server;
let origin: string;

async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), 'download-runtime-'));
  temporaryDirectories.push(result);
  return result;
}

function task(kind: 'hls' | 'dash', url: string, title: string, outputFormat: 'mp4' | 'original' = 'mp4'): DownloadTask {
  return {
    id: title,
    source: { id: title, adapterId: 'direct', pageUrl: url, title, mediaKind: kind },
    outputFormat, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(),
  };
}

beforeAll(async () => {
  const tracks = new Map<string, { init: Uint8Array; data: Uint8Array }>();
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: true });
  transmuxer.on('data', (segment) => tracks.set(segment.type, { init: segment.initSegment, data: segment.data }));
  const done = new Promise<void>((resolve) => transmuxer.on('done', resolve));
  transmuxer.push(transportStream);
  transmuxer.flush();
  await done;
  for (const name of ['video', 'audio']) {
    const track = tracks.get(name)!;
    resources.set(`/${name}-init.mp4`, track.init);
    resources.set(`/${name}-1.m4s`, track.data);
  }
  resources.set('/one.ts', transportStream);
  resources.set('/two.ts', transportStream);
  resources.set('/one.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\none.ts\n#EXT-X-ENDLIST');
  resources.set('/resume.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\none.ts\n#EXTINF:10,\ntwo.ts\n#EXT-X-ENDLIST');
  resources.set('/manifest.mpd', `<MPD type="static" mediaPresentationDuration="PT10S"><Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <Representation id="video" bandwidth="1000000"><SegmentTemplate timescale="1" duration="10"
        initialization="video-init.mp4" media="video-$Number$.m4s" startNumber="1" /></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2">
      <Representation id="audio" bandwidth="128000"><SegmentTemplate timescale="1" duration="10"
        initialization="audio-init.mp4" media="audio-$Number$.m4s" startNumber="1" /></Representation>
    </AdaptationSet></Period></MPD>`);
  server = createServer((request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    requests.push(pathname);
    if (pathname === '/two.ts' && failSecondSegment) {
      response.writeHead(503).end('fixture failure');
      return;
    }
    const body = resources.get(pathname);
    if (body === undefined) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/octet-stream' });
    response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP fixture address.');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Node host using the shared download runtime', () => {
  it('downloads and validates TS-to-MP4 HLS without browser globals', async () => {
    const host = await createNodeHost({ outputDirectory: await directory(), networkSettings: testNetwork });
    await host.store.save(task('hls', `${origin}/one.m3u8`, 'hls-movie'));
    const result = await host.runtime.start();
    expect(result.tasks[0], JSON.stringify(result.tasks[0])).toMatchObject({ status: 'completed' });
    const validation = await validateMediaOutput(await readMediaArtifact(host.artifacts, 'hls-movie.mp4'), { format: 'mp4', requireVideo: true });
    expect(validation).toMatchObject({ videoTracks: 1, audioTracks: 1, fragmented: false });
    expect(await host.artifacts.stat('hls-movie.part.ts')).toBeNull();
    expect(await readdir(host.artifacts.root)).not.toEqual(expect.arrayContaining([expect.stringContaining('.pending')]));
  });

  it('parses a DASH manifest, downloads both tracks, merges and validates the final file', async () => {
    const host = await createNodeHost({ outputDirectory: await directory(), networkSettings: testNetwork });
    await host.store.save(task('dash', `${origin}/manifest.mpd`, 'dash-movie'));
    const result = await host.runtime.start();
    expect(result.tasks[0], JSON.stringify(result.tasks[0])).toMatchObject({ status: 'completed' });
    const validation = await validateMediaOutput(await readMediaArtifact(host.artifacts, 'dash-movie.mp4'), { format: 'mp4', requireVideo: true });
    expect(validation).toMatchObject({ videoTracks: 1, audioTracks: 1, fragmented: false });
    expect(await host.artifacts.stat('dash-movie.video.part.m4s')).toBeNull();
    expect(await host.artifacts.stat('dash-movie.audio.part.m4s')).toBeNull();
  });

  it('reconstructs a fresh host from disk and resumes only the missing HLS segment', async () => {
    requests.length = 0;
    failSecondSegment = true;
    const outputDirectory = await directory();
    const original = await createNodeHost({ outputDirectory, networkSettings: testNetwork });
    await original.store.save(task('hls', `${origin}/resume.m3u8`, 'recovered', 'original'));
    await original.runtime.start();
    const [failed] = await original.store.list();
    expect(failed).toMatchObject({ status: 'failed', checkpoint: { completedSegments: 1 } });
    expect((await original.artifacts.stat('recovered.part.ts'))?.size).toBe(transportStream.byteLength);
    failSecondSegment = false;
    const recovered = await createNodeHost({ outputDirectory, networkSettings: testNetwork });
    expect(recovered.artifacts.id).toBe(original.artifacts.id);
    await recovered.runtime.retry('recovered');
    await recovered.runtime.start();
    expect((await recovered.store.list())[0]).toMatchObject({ status: 'completed' });
    expect(requests.filter((path) => path === '/one.ts')).toHaveLength(1);
    expect(requests.filter((path) => path === '/two.ts')).toHaveLength(2);
    expect((await recovered.artifacts.stat('recovered.ts'))?.size).toBe(transportStream.byteLength * 2);
    expect(await recovered.artifacts.stat('recovered.part.ts')).toBeNull();
  });

  it('runs the real CLI in a fresh Node process against local HTTP media', async () => {
    const outputDirectory = await directory();
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/runtime-cli.ts',
      '--url', `${origin}/one.m3u8`, '--kind', 'hls', '--output', outputDirectory, '--title', 'cli-movie'],
    { cwd: process.cwd(), env: { ...process.env, TSX_TSCONFIG_PATH: resolve('tsconfig.runtime.json') },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const [code] = await once(child, 'close');
    expect(code, stderr || stdout).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ tasks: [{ status: 'completed' }] });
    const artifacts = await NodeArtifactStore.create(outputDirectory);
    expect(await validateMediaOutput(await readMediaArtifact(artifacts, 'cli-movie.mp4'), { format: 'mp4' }))
      .toMatchObject({ videoTracks: 1, audioTracks: 1 });
  });
});

describe('Node host boundaries', () => {
  it('truncates to a checkpoint, preserves aborted partial writes, and isolates fresh writes', async () => {
    const artifacts = await NodeArtifactStore.create(await directory());
    await writeFile(join(artifacts.root, 'partial'), Uint8Array.of(1, 2, 3, 99, 99));
    const resumed = await artifacts.open('partial', { resumeFrom: 3 });
    await resumed.write(Uint8Array.of(4));
    await resumed.writeAt(0, Uint8Array.of(7));
    await resumed.abort();
    expect(await artifacts.read('partial', 0, 10)).toEqual(Uint8Array.of(7, 2, 3, 4));
    const replacement = await artifacts.open('partial');
    await replacement.write(Uint8Array.of(8));
    await replacement.abort();
    expect(await artifacts.read('partial', 0, 10)).toEqual(Uint8Array.of(7, 2, 3, 4));
    await expect(artifacts.open('partial', { resumeFrom: 5 })).rejects.toThrow(/shorter/);
    await expect(artifacts.open('../outside')).rejects.toThrow(/single filename/);
    await symlink(join(artifacts.root, 'partial'), join(artifacts.root, 'link'));
    await expect(artifacts.read('link', 0, 1)).rejects.toThrow();
  });

  it('serializes real processes and releases execution ownership after process death', async () => {
    const lock = new NodeExecutionLocks(await directory());
    const moduleUrl = pathToFileURL(resolve('src/hosts/node/execution-locks.ts')).href;
    const source = `import { NodeExecutionLocks } from ${JSON.stringify(moduleUrl)};
      await new NodeExecutionLocks('test', ${lock.port}).runExclusive(async () => {
        process.stdout.write('locked\\n'); await new Promise(() => {});
      });`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source],
      { cwd: process.cwd(), env: { ...process.env, TSX_TSCONFIG_PATH: resolve('tsconfig.runtime.json') },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { error += String(chunk); });
    try {
      const first = await Promise.race([
        once(child.stdout, 'data').then(() => 'locked'),
        once(child, 'close').then(() => `closed: ${error}`),
      ]);
      expect(first).toBe('locked');
      await expect(lock.runExclusive(async () => {})).rejects.toMatchObject({ code: 'runtimeBusy' });
      child.kill('SIGKILL');
      await once(child, 'close');
      await expect(lock.runExclusive(async () => 'new owner')).resolves.toBe('new owner');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'close');
      }
    }
  });

  it('uses an explicit credential-free transport and rejects non-HTTP sources', async () => {
    let received: RequestInit | undefined;
    const transport = createNodeTransport(async (_input, init) => {
      received = init;
      return new Response('ok');
    });
    await transport.fetch('https://example.test/media', { credentials: 'include' });
    expect(received?.credentials).toBe('omit');
    expect(() => transport.fetch('file:///etc/passwd')).toThrow(/HTTP and HTTPS/);
  });
});
