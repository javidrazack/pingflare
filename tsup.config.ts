import { defineConfig } from 'tsup'
import path from 'node:path'

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist-server',
  external: ['better-sqlite3'],
  esbuildOptions(options) {
    options.alias = {
      'cloudflare:sockets': path.resolve('src/shims/cloudflare-sockets.ts'),
    }
  },
})
