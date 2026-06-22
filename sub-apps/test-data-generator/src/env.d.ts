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
}

interface Window {
  electronAPI?: ElectronAPI
}
