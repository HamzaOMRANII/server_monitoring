// CommonJS on purpose: the package isn't "type": "module", matching
// it.omranisystems.com so pm2 can require() ecosystem configs.
const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react').default;

// Client source lives in src/client; index.html at the root is the entry.
// `npm run build` writes dist/, which src/server.js serves in production.
// In dev, Vite serves the client on :16001 and proxies /api to the backend
// (src/server.js) on :16000.
module.exports = defineConfig({
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 16001,
    proxy: {
      '/api': 'http://127.0.0.1:16000',
      '/healthz': 'http://127.0.0.1:16000',
    },
  },
});
