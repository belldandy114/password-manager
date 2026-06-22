const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Save file dialog + write combo
  saveFile: async (defaultName, content, filters, encoding) => {
    const { canceled, filePath } = await ipcRenderer.invoke('dialog:saveFile', {
      defaultName,
      filters,
    })
    if (canceled || !filePath) return { success: false, reason: 'canceled' }

    return ipcRenderer.invoke('fs:writeFile', { filePath, content, encoding })
  },
})
