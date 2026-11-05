import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 第三方库单独成块：它们几乎不随业务代码变化，换版本时能命中缓存
    rolldownOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'vendor-react'
          if (id.includes('node_modules/zustand')) return 'vendor-state'
          return undefined
        }
      }
    }
  },
  server: {
    port: 5173
  }
})
