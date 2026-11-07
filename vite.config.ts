/// <reference types="vitest/config" />
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
  },
  test: {
    // 既有工具层测试仍在 node 环境；组件测试文件用 @vitest-environment jsdom 单独声明
    environment: 'node',
    pool: 'forks',
    // 45 个测试文件默认会同时拉起几十个 fork，在开发机/CI 负载高时个别 worker
    // 起不来，报 "Timeout waiting for worker to respond"，整轮被判失败（测试其实全绿）。
    // Vitest 4+ 用顶层 maxWorkers 限制并发度，换确定性：整套测试只跑一两秒，慢点无所谓。
    minWorkers: 1,
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/__tests__/**', 'src/**/*.d.ts', 'src/main.tsx', 'src/vite-env.d.ts'],
    },
  },
})
