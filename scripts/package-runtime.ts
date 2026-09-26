import { readFile, writeFile } from 'node:fs/promises';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await writeFile(new URL('../.output/runtime/package.json', import.meta.url), JSON.stringify({
  name: '@open-media-downloader/runtime', version: pkg.version, private: true, type: 'module',
  exports: {
    '.': { types: './types/runtime/index.d.ts', import: './index.js' },
    './node': { types: './types/hosts/node/index.d.ts', import: './node.js' },
  },
  dependencies: Object.fromEntries(['zod', 'fast-xml-parser', 'googlevideo', 'mux.js'].map((name) => [name, pkg.dependencies[name]])),
}, null, 2) + '\n');
