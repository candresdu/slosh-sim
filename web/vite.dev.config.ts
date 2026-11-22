// Builds the dev pages (dev/*.html) as a normal app, so view code is bundled and checked by `vite build`.
// Output: dist-dev/ (not committed). The library build for the element stays in vite.config.ts.
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    outDir: 'dist-dev',
    emptyOutDir: true,
    rollupOptions: { input: { scene: 'dev/scene.html', charts: 'dev/charts.html' } },
  },
});
