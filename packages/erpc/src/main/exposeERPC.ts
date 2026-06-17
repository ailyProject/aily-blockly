import { contextBridge, ipcRenderer } from 'electron'

import { ERPC_CHANNEL } from '../constants'

import type { GlobalERPC } from '../types'

export const exposeElectronTRPC = () => {
	const ERPC: GlobalERPC = {
		sendMessage: operation => ipcRenderer.send(ERPC_CHANNEL, operation),
		onMessage: callback => ipcRenderer.on(ERPC_CHANNEL, (_event, args) => callback(args))
	}

	contextBridge.exposeInMainWorld('$erpc', ERPC)
}
