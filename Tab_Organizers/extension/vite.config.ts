import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json' with { type: 'json' };
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    rollupOptions: { input: { popup: fileURLToPath(new URL('./src/popup/popup.html', import.meta.url)) } },
    outDir: 'dist',
    emptyOutDir: true,
  }
});
