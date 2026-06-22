import { joinFatfsListPath } from './shared'

/**
 * 解析 FATFS 列表接口返回的文本条目。
 * @param payload - 原始列表文本
 * @param basePath - 当前目录
 */
export const parseFatfsEntries = (payload: string, basePath: string) =>
	payload
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [rawPath = '', rawSize = '0', rawType = 'f'] = line.split('\t')
			return {
				path: joinFatfsListPath(basePath, rawPath),
				size: Number(rawSize) || 0,
				type: rawType === 'd' ? 'dir' : 'file'
			}
		})
