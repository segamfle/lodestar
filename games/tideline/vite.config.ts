import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` is relative so the same build works from a GitHub Pages subpath, from a bare
// domain, and from a local preview without a rebuild. The jam requires the page to run
// standalone at its own URL as well as inside the host iframe, and an absolute base would
// break one of those two.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: true },
});
