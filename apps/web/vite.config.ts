import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Local dev topology: the browser only ever calls the relative `/api/v1/...`; Vite forwards it to
 * the local Worker (`pnpm dev:worker`, 127.0.0.1:8787). No backend URL is compiled into the app.
 */
const WORKER_DEV_URL = 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    host: 'localhost',
    proxy: { '/api': { target: WORKER_DEV_URL, changeOrigin: true } },
  },
  preview: { port: 4173, strictPort: true, host: 'localhost' },
  build: { sourcemap: true },
});
