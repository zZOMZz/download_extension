import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const outputDirectory = resolve('.output/runtime');
interface RuntimePackage {
  exports: Record<string, { import: string; types: string }>;
  dependencies: Record<string, string>;
}

async function check(): Promise<void> {
  const pkg = JSON.parse(await readFile(join(outputDirectory, 'package.json'), 'utf8')) as RuntimePackage;
  const entries: Record<string, string> = {};
  for (const name of ['.', './node']) {
    const entry = pkg.exports[name];
    if (!entry) throw new Error(`Missing runtime package export ${name}.`);
    const path = resolve(outputDirectory, entry.import);
    const fromRoot = relative(outputDirectory, path);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('Runtime exports must remain inside the package.');
    await access(path);
    await access(resolve(outputDirectory, entry.types));
    entries[name] = pathToFileURL(path).href;
  }

  // Inspect the actual bundler module/import graph; prose, error strings and type-only
  // DOM references must not produce a false platform-dependency finding.
  const generated = await build({ configFile: resolve('vite.runtime.config.ts'),
    logLevel: 'error', build: { write: false } });
  const results = Array.isArray(generated) ? generated : [generated];
  const modules = new Set<string>();
  for (const result of results) {
    if (!('output' in result)) throw new Error('Expected a one-shot runtime library build.');
    const emittedFiles = new Set(result.output.map((entry) => entry.fileName));
    const chunks = new Map(result.output.filter((entry) => entry.type === 'chunk')
      .map((entry) => [entry.fileName, entry]));
    const portableEntry = pkg.exports['.']!.import.replace(/^\.\//, '');
    const visited = new Set<string>();
    const inspectPortable = (filename: string): void => {
      if (visited.has(filename)) return;
      visited.add(filename);
      const chunk = chunks.get(filename);
      if (!chunk) throw new Error(`Missing portable runtime chunk: ${filename}`);
      for (const specifier of [...chunk.imports, ...chunk.dynamicImports]) {
        if (specifier.startsWith('node:')) {
          throw new Error(`Node import leaked into the portable runtime entry: ${specifier}`);
        }
        const child = specifier.replace(/^\.\//, '');
        if (chunks.has(child)) inspectPortable(child);
      }
    };
    inspectPortable(portableEntry);
    for (const chunk of result.output) {
      if (chunk.type !== 'chunk') continue;
      const emitted = await readFile(join(outputDirectory, chunk.fileName), 'utf8').catch(() => undefined);
      if (emitted !== chunk.code) throw new Error('The runtime artifact is stale; run pnpm build:runtime before checking it.');
      for (const id of Object.keys(chunk.modules)) {
        const normalized = id.replaceAll('\\', '/');
        if (/\/(?:src\/browser|entrypoints|src\/core\/detection)\//.test(normalized) ||
          /\/src\/core\/discovery\/(?:registry|adapters)\b/.test(normalized) ||
          /\/sabr-request-observer\.[cm]?[jt]s$/.test(normalized) ||
          /\/node_modules\/(?:wxt|react|react-dom)(?:\/|$)/.test(normalized)) {
          throw new Error(`Platform module leaked into the runtime build: ${id}`);
        }
        modules.add(id);
      }
      for (const specifier of [...chunk.imports, ...chunk.dynamicImports]) {
        if (emittedFiles.has(specifier) || specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
        if (!(packageName in pkg.dependencies)) {
          throw new Error(`Undeclared external runtime import: ${specifier}`);
        }
      }
    }
  }

  const scratch = await mkdtemp(join(tmpdir(), 'runtime-build-check-'));
  // Reuse the installed mux.js fixture instead of maintaining a duplicate media asset.
  const segment = await readFile('node_modules/mux.js/test/segments/test-segment.ts');
  const requests: string[] = [];
  const fixture = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/movie.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
        .end('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST');
    } else if (request.url === '/segment.ts') {
      response.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(segment);
    } else response.writeHead(404).end();
  });
  try {
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('The HTTP fixture did not bind TCP.');
    const url = `http://127.0.0.1:${address.port}/movie.m3u8`;
    // This is ordinary compiled JavaScript, run by a child with no tsx/TS loader,
    // no source path aliases, and no dependency on the current working directory.
    const smoke = `
      import assert from 'node:assert/strict';
      const runtime = await import(${JSON.stringify(entries['.'])});
      const node = await import(${JSON.stringify(entries['./node'])});
      assert.equal(typeof globalThis.window, 'undefined');
      assert.equal(typeof globalThis.document, 'undefined');
      assert.equal(typeof globalThis.browser, 'undefined');
      assert.equal(typeof runtime.DownloadRuntime, 'function');
      const host = await node.createNodeHost({ outputDirectory: ${JSON.stringify(join(scratch, 'media'))},
        networkSettings: { ...runtime.NETWORK_PRESETS.balanced, maxAttempts: 1, taskRecoveryAttempts: 0 } });
      await host.runtime.enqueue([{ id: 'build-smoke', adapterId: 'direct', title: 'bundle-smoke',
        pageUrl: ${JSON.stringify(url)}, mediaKind: 'hls' }], 'mp4');
      const result = await host.runtime.start();
      assert.equal(result.tasks[0]?.status, 'completed', JSON.stringify(result.tasks));
      const validation = await runtime.validateMediaOutput(
        await runtime.readMediaArtifact(host.artifacts, 'bundle-smoke.mp4'), { format: 'mp4', requireVideo: true });
      assert.equal(validation.videoTracks, 1);
      assert.equal(validation.audioTracks, 1);
      assert.equal(validation.fragmented, false);
      console.log(JSON.stringify({ status: 'completed', ...validation }));
    `;
    const environment = { ...process.env };
    delete environment.NODE_OPTIONS;
    delete environment.TSX_TSCONFIG_PATH;
    const child = spawn(process.execPath, ['--input-type=module', '-e', smoke], {
      cwd: scratch, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += String(data); });
    child.stderr.on('data', (data) => { stderr += String(data); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    let status: number | null;
    try { [status] = await once(child, 'close') as [number | null]; }
    finally { clearTimeout(timeout); }
    if (status !== 0) throw new Error(`Compiled runtime smoke failed (${status}): ${stderr || stdout}`);
    if (!requests.includes('/movie.m3u8') || !requests.includes('/segment.ts')) {
      throw new Error('The compiled runtime did not request both manifest and media from the fixture.');
    }
    process.stdout.write(`RUNTIME_BUILD_VERIFIED ${JSON.stringify({ modules: modules.size,
      exports: Object.keys(entries), smoke: JSON.parse(stdout) })}\n`);
  } finally {
    fixture.closeAllConnections();
    if (fixture.listening) await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
}

check().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
