import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { API_METHODS, SIGNAL_METHODS, type Api, type Bridge, type MainEvent, type Signals } from '../shared/types'

// Electron prefixes errors from ipcMain.handle; show users just the message.
function cleanError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  return new Error(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
}

const invoke = Object.fromEntries(
  API_METHODS.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke('foreman:invoke', method, args).catch((err) => Promise.reject(cleanError(err)))
  ])
) as unknown as Api

const send = Object.fromEntries(
  SIGNAL_METHODS.map((method) => [method, (...args: unknown[]) => ipcRenderer.send('foreman:send', method, args)])
) as unknown as Signals

const bridge: Bridge = {
  browser: {
    selectElement: (workspaceId) => ipcRenderer.invoke('foreman:browser-select', workspaceId).catch((err) => Promise.reject(cleanError(err))),
    command: (workspaceId, command) => ipcRenderer.invoke('foreman:browser', workspaceId, command).catch((err) => Promise.reject(cleanError(err))),
    capture: (workspaceId) => ipcRenderer.invoke('foreman:browser-capture', workspaceId).catch((err) => Promise.reject(cleanError(err)))
  },
  invoke,
  send,
  onEvent(listener) {
    const handler = (_event: IpcRendererEvent, payload: MainEvent) => listener(payload)
    ipcRenderer.on('foreman:event', handler)
    return () => ipcRenderer.removeListener('foreman:event', handler)
  },
  pathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('foreman', bridge)
