/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface ElectronAPI {
  saveFile: (
    defaultName: string,
    content: string | Uint8Array,
    filters?: { name: string; extensions: string[] }[],
    encoding?: string
  ) => Promise<{ success: boolean; reason?: string }>
  /** 把生成结果交给主窗口的「接口调试」填进请求体 */
  toApiBody?: (values: string[]) => Promise<{ success: boolean; data?: { count: number; truncated: boolean }; error?: string }>
}

interface Window {
  electronAPI?: ElectronAPI
}
