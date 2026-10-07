import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'url'

export default defineConfig(({ mode }) => {
  // The adapter's HTTP server (uploads, share snapshots). In prod nginx
  // proxies these paths to it; in dev this server does. Override in
  // frontend/.env.local when the dev stack publishes it elsewhere.
  const adapterHttp = loadEnv(mode, process.cwd(), '').LABWEAVER_ADAPTER_HTTP || 'http://localhost:5000'
  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      proxy: {
        '/upload': adapterHttp,
        '/share-snapshot': adapterHttp,
      },
    },
  }
})
