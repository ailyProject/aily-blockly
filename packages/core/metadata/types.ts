export interface BlocklyWorkspaceBlockNode {
	type?: string
	inputs?: Record<string, { block?: BlocklyWorkspaceBlockNode; shadow?: BlocklyWorkspaceBlockNode }>
	next?: { block?: BlocklyWorkspaceBlockNode }
}

export interface BlocklyWorkspaceContent {
	blocks?: {
		blocks?: Array<BlocklyWorkspaceBlockNode>
	}
}

export interface BlocklyProjectDocumentPage {
	content?: BlocklyWorkspaceContent | null
}

export interface BlocklyProjectDocument {
	pages: Array<BlocklyProjectDocumentPage>
	sharedModel?: {
		procedureBlocks?: Array<BlocklyWorkspaceBlockNode>
	}
}

export interface BlocklyUsedLibraryManifestEntry {
	version: string
	localPath?: string
	blockTypes: Array<string>
	updatedAt: number
}

export type BlocklyUsedLibraryManifest = Record<string, BlocklyUsedLibraryManifestEntry>

export interface BlockLibraryBinding {
	name: string
	version: string
	localPath?: string
}
