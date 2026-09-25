import { defineConfig } from 'vite';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  worker: {
    format: 'es',
  },
  server: {
    headers: isolationHeaders,
    allowedHosts: ['.trycloudflare.com'],
  },
  preview: { headers: isolationHeaders },
});
