import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Library build: one ES module, dist/slosh-sim.js (Three.js and uPlot bundled, CSS inlined).
 * The demo and E2E pages sit next to it in dist/ (index.html, e2e/pages/*.html) so that
 * `npx vite preview` serves them with a relative script path; they are not part of a release.
 */
function copyPages(): Plugin {
  return {
    name: 'slosh-copy-pages',
    apply: 'build',
    closeBundle() {
      const out = resolve(import.meta.dirname, 'dist');
      mkdirSync(resolve(out, 'e2e/pages'), { recursive: true });
      cpSync(resolve(import.meta.dirname, 'index.html'), resolve(out, 'index.html'));
      cpSync(resolve(import.meta.dirname, 'e2e/pages'), resolve(out, 'e2e/pages'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [
    copyPages(),
    // `npm run analyze` writes the per-module breakdown used in reports/bundle.md
    ...(process.env.ANALYZE
      ? [visualizer({ filename: 'dist-dev/stats.json', template: 'raw-data', gzipSize: true })]
      : []),
  ],
  server: {
    // shared/ lives next to web/ and is imported at build time
    fs: { allow: ['..'] },
  },
  build: {
    target: 'es2022',
    lib: {
      entry: 'src/element/slosh-sim.ts',
      formats: ['es'],
      fileName: 'slosh-sim',
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
