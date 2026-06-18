import { z } from 'zod'

import { countAbiBlocks, normalizeProjectAbi, parseProjectAbiText, stringifyProjectAbi } from '../abi'
import { normalizeProjectDocument } from '../document'
import { p, r } from './trpc'

const abiPayloadSchema = z.object({
	/** 原始 ABI / 项目文档载荷 */
	payload: z.unknown()
})

const abiTextSchema = z.object({
	/** project.abi 文件文本内容 */
	raw: z.string()
})

/**
 * 暴露项目文档与 ABI 的纯转换能力
 */
export default r({
	normalizeProjectDocument: p.input(abiPayloadSchema).query(({ input }) => normalizeProjectDocument(input.payload)),
	normalizeProjectAbi: p.input(abiPayloadSchema).query(({ input }) => normalizeProjectAbi(input.payload)),
	parseProjectAbiText: p.input(abiTextSchema).query(({ input }) => parseProjectAbiText(input.raw)),
	stringifyProjectAbi: p.input(abiPayloadSchema).query(({ input }) => stringifyProjectAbi(input.payload)),
	countAbiBlocks: p.input(abiPayloadSchema).query(({ input }) => countAbiBlocks(input.payload))
})
