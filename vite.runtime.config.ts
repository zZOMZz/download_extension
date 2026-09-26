import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: '.output/runtime',
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: { index: resolve('src/runtime/index.ts'), node: resolve('src/hosts/node/index.ts') },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: (id) => id.startsWith('node:') || /^(zod|fast-xml-parser|googlevideo|mux\.js)(\/|$)/.test(id),
    },
  },
});
