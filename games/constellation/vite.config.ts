import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so one build serves the Pages subpath, a bare domain and a local preview
// without rebuilding. The jam needs the page to work standalone as well as in the host
// iframe, and an absolute base breaks one of the two.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: true },
});
