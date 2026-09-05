import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so one build serves a Pages subpath and a bare domain alike.
export default defineConfig({
  base: './',
  plugins: [react()],
  define: { global: 'globalThis' },
  optimizeDeps: { include: ['buffer'] },
  build: { outDir: 'dist', sourcemap: true },
});
