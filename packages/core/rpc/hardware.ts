import { z } from 'zod'

import {
	getBoardCategories,
	getLibraryCategories,
	searchHardwareIndexCompat,
	validateLegacyBoard,
	validateLegacyLibrary
} from '../hardware'
import { p, r } from './trpc'

const legacyBoardItemSchema = z.object({
	/** 包名或唯一名称 */
	name: z.string(),
	/** 展示昵称 */
	nickname: z.string().optional(),
	/** 展示名称 */
	displayName: z.string().optional(),
	/** 描述 */
	description: z.string().optional(),
	/** 关键词 */
	keywords: z.array(z.string()).optional(),
	/** 品牌 */
	brand: z.string().optional(),
	/** 类型 */
	type: z.string().optional()
})

const legacyLibraryItemSchema = z.object({
	/** 包名或唯一名称 */
	name: z.string(),
	/** 展示昵称 */
	nickname: z.string().optional(),
	/** 描述 */
	description: z.string().optional(),
	/** 关键词 */
	keywords: z.array(z.string()).optional(),
	/** 作者 */
	author: z.string().optional(),
	/** 兼容性信息 */
	compatibility: z.object({ core: z.array(z.string()).optional() }).optional()
})

const boardIndexItemSchema = z.object({
	name: z.string(),
	displayName: z.string(),
	brand: z.string(),
	type: z.enum(['board', 'series']),
	architecture: z.string(),
	cores: z.number(),
	frequency: z.number(),
	frequencyUnit: z.string(),
	flash: z.number(),
	sram: z.number(),
	psram: z.number(),
	connectivity: z.array(z.string()),
	interfaces: z.array(z.string()),
	core: z.string(),
	voltage: z.number(),
	mcu: z.string().optional(),
	gpio: z.object({ digital: z.number(), analog: z.number(), pwm: z.number() }).optional(),
	features: z.array(z.string()).optional(),
	tags: z.array(z.string()),
	keywords: z.array(z.string()).optional(),
	description: z.string().optional()
})

const libraryIndexItemSchema = z.object({
	name: z.string(),
	displayName: z.string(),
	category: z.string(),
	supportedCores: z.array(z.string()),
	communication: z.array(z.string()),
	voltage: z.array(z.number()),
	hardwareType: z.array(z.string()),
	compatibleHardware: z.array(z.string()),
	tags: z.array(z.string()),
	subcategory: z.string().optional(),
	functions: z.array(z.string()).optional(),
	keywords: z.array(z.string()).optional(),
	description: z.string().optional(),
	author: z.string().optional()
})

/**
 * 暴露硬件搜索、分类和 legacy 校验规则。
 */
export default r({
	validateLegacyBoard: p
		.input(z.object({ boardName: z.string(), boards: z.array(legacyBoardItemSchema) }))
		.query(({ input }) => validateLegacyBoard(input.boardName, input.boards)),
	validateLegacyLibrary: p
		.input(z.object({ libraryName: z.string(), libraries: z.array(legacyLibraryItemSchema) }))
		.query(({ input }) => validateLegacyLibrary(input.libraryName, input.libraries)),
	getBoardCategories: p
		.input(
			z.object({
				boards: z.array(boardIndexItemSchema),
				dimension: z.enum(['brand', 'architecture', 'connectivity', 'interfaces', 'tags'])
			})
		)
		.query(({ input }) => getBoardCategories(input.boards, input.dimension)),
	getLibraryCategories: p
		.input(
			z.object({
				libraries: z.array(libraryIndexItemSchema),
				dimension: z.enum(['category', 'hardwareType', 'communication', 'supportedCores'])
			})
		)
		.query(({ input }) => getLibraryCategories(input.libraries, input.dimension)),
	searchCompat: p
		.input(
			z.object({
				boards: z.array(boardIndexItemSchema),
				libraries: z.array(libraryIndexItemSchema),
				query: z.object({
					query: z.union([z.string(), z.array(z.string())]).optional(),
					type: z.enum(['boards', 'libraries', 'both']).optional(),
					filters: z
						.object({
							keywords: z.union([z.string(), z.array(z.string())]).optional(),
							flash: z.string().optional(),
							sram: z.string().optional(),
							frequency: z.string().optional(),
							cores: z.string().optional(),
							architecture: z.string().optional(),
							connectivity: z.array(z.string()).optional(),
							interfaces: z.array(z.string()).optional(),
							brand: z.string().optional(),
							voltage: z.string().optional(),
							category: z.string().optional(),
							hardwareType: z.array(z.string()).optional(),
							supportedCores: z.array(z.string()).optional(),
							communication: z.array(z.string()).optional()
						})
						.optional(),
					maxResults: z.number().optional()
				}),
				legacy: z
					.object({
						legacyBoards: z.array(legacyBoardItemSchema).optional(),
						legacyLibraries: z.array(legacyLibraryItemSchema).optional()
					})
					.optional()
			})
		)
		.query(({ input }) => searchHardwareIndexCompat(input.boards, input.libraries, input.query, input.legacy))
})
