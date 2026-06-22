import type { FfsRuntimeClient, FfsSpiffsClient, FfsTreeFilesystemClient } from './types'

export const isSpiffsClient = (client: FfsRuntimeClient): client is FfsSpiffsClient =>
	'read' in client && 'write' in client && 'remove' in client

export const getTreeClient = (client: FfsRuntimeClient): FfsTreeFilesystemClient => client as FfsTreeFilesystemClient
