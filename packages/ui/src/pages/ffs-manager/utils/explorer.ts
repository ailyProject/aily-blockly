import type { FfsExplorerBreadcrumb, FfsExplorerEntry } from '../types'

const textPreviewExtensions = [
	'txt',
	'log',
	'md',
	'cfg',
	'ini',
	'conf',
	'json',
	'yaml',
	'yml',
	'xml',
	'toml',
	'js',
	'ts',
	'py',
	'c',
	'cpp',
	'h',
	'hpp',
	'sh',
	'csv',
	'html',
	'htm',
	'css'
]
const imagePreviewExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico']
const audioPreviewExtensions = ['mp3', 'wav', 'ogg', 'flac', 'm4a']

const getFileExtension = (fileName: string) => fileName.split('.').pop()?.toLowerCase() || ''

/**
 * 解析文件预览模式。
 * @param fileName - 文件名
 */
export const getFfsPreviewMode = (fileName: string): FfsExplorerEntry['previewMode'] => {
	const extension = getFileExtension(fileName)
	if (imagePreviewExtensions.includes(extension)) return 'image'
	if (audioPreviewExtensions.includes(extension)) return 'audio'
	if (textPreviewExtensions.includes(extension)) return 'text'
	return null
}

/**
 * 构建当前路径的面包屑。
 * @param currentPath - 当前目录路径
 */
export const buildFfsBreadcrumbs = (currentPath: string): Array<FfsExplorerBreadcrumb> => {
	const segments = currentPath.split('/').filter(Boolean)
	const items: Array<FfsExplorerBreadcrumb> = [{ name: 'root', path: '/' }]
	let path = ''

	for (const segment of segments) {
		path += `/${segment}`
		items.push({ name: segment, path })
	}

	return items
}

/**
 * 由扁平文件列表投影当前目录的可视条目。
 * @param options - 目录投影输入
 */
export const buildFfsExplorerEntries = (options: {
	currentPath: string
	files: Array<{ path: string; name?: string; type: 'file' | 'dir'; size: number; sizeText: string }>
}): Array<FfsExplorerEntry> => {
	const prefix = options.currentPath === '/' ? '/' : `${options.currentPath}/`
	const directoryMap = new Map<string, FfsExplorerEntry>()
	const fileEntries: Array<FfsExplorerEntry> = []

	for (const file of options.files) {
		const fullPath = file.path.startsWith('/') ? file.path : `/${file.path}`
		if (!fullPath.startsWith(prefix) && fullPath !== options.currentPath) continue

		const relativePath = fullPath.slice(prefix.length)
		if (!relativePath) continue

		const separatorIndex = relativePath.indexOf('/')
		if (file.type === 'dir') {
			const directoryName = separatorIndex === -1 ? relativePath : relativePath.slice(0, separatorIndex)
			if (!directoryMap.has(directoryName)) {
				directoryMap.set(directoryName, {
					name: directoryName,
					fullPath: `${prefix}${directoryName}/`,
					type: 'dir',
					sizeText: '',
					size: 0,
					previewMode: null
				})
			}
			continue
		}

		if (separatorIndex !== -1) {
			const directoryName = relativePath.slice(0, separatorIndex)
			if (!directoryMap.has(directoryName)) {
				directoryMap.set(directoryName, {
					name: directoryName,
					fullPath: `${prefix}${directoryName}/`,
					type: 'dir',
					sizeText: '',
					size: 0,
					previewMode: null
				})
			}
			continue
		}

		fileEntries.push({
			name: relativePath,
			fullPath,
			type: 'file',
			sizeText: file.sizeText,
			size: file.size,
			previewMode: getFfsPreviewMode(relativePath)
		})
	}

	const directories = [...directoryMap.values()].sort((left, right) => left.name.localeCompare(right.name))
	fileEntries.sort((left, right) => left.name.localeCompare(right.name))
	return [...directories, ...fileEntries]
}
