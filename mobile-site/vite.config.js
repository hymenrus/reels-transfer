import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    allowedHosts: ['.sg2.manus.computer'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
