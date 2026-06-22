/**
 * 开发板索引条目类型
 */
export type BoardIndexItemType =
	/** 单块开发板 */
	| 'board'
	/** 系列或聚合占位条目 */
	| 'series'

/**
 * 开发板索引条目
 */
export interface BoardIndexItem {
	/** 包名或索引中的唯一名称 */
	name: string
	/** 面向用户展示的名称 */
	displayName: string
	/** 开发板品牌 */
	brand: string
	/** 条目类型：单板或系列占位 */
	type: BoardIndexItemType
	/** 处理器架构标识 */
	architecture: string
	/** CPU 核心数量 */
	cores: number
	/** 主频数值 */
	frequency: number
	/** 主频单位，通常为 MHz */
	frequencyUnit: string
	/** Flash 容量，单位 KB */
	flash: number
	/** SRAM 容量，单位 KB */
	sram: number
	/** PSRAM 容量，单位 KB */
	psram: number
	/** 板载连接能力，例如 wifi、ble */
	connectivity: Array<string>
	/** 暴露的接口能力，例如 i2c、spi、camera */
	interfaces: Array<string>
	/** 对应 Arduino / platform core 标识 */
	core: string
	/** 工作电压 */
	voltage: number
	/** MCU 型号 */
	mcu?: string
	/** GPIO 能力摘要 */
	gpio?: {
		/** 可用数字引脚数量 */
		digital: number
		/** 可用模拟引脚数量 */
		analog: number
		/** 可用 PWM 引脚数量 */
		pwm: number
	}
	/** 额外特性标签 */
	features?: Array<string>
	/** 搜索与归类标签 */
	tags: Array<string>
	/** 额外关键词 */
	keywords?: Array<string>
	/** 简要说明 */
	description?: string
}

/**
 * 旧格式开发板条目
 */
export interface LegacyBoardItem {
	/** 包名或唯一名称 */
	name: string
	/** 展示昵称 */
	nickname?: string
	/** 展示名称 */
	displayName?: string
	/** 描述 */
	description?: string
	/** 关键词 */
	keywords?: Array<string>
	/** 品牌 */
	brand?: string
	/** 类型 */
	type?: string
}

/**
 * 开发板验证结果
 */
export interface BoardValidationResult {
	/** 是否命中开发板 */
	exists: boolean
	/** 命中的开发板条目 */
	board: LegacyBoardItem | null
	/** 是否通过模糊匹配命中 */
	fuzzyMatch: boolean
	/** 原始查询词 */
	originalQuery: string
}

/**
 * 开发板分类维度
 */
export type BoardCategoryDimension =
	/** 按品牌分类 */
	| 'brand'
	/** 按处理器架构分类 */
	| 'architecture'
	/** 按连接能力分类 */
	| 'connectivity'
	/** 按接口能力分类 */
	| 'interfaces'
	/** 按标签分类 */
	| 'tags'

/**
 * 分类统计项
 */
export interface CategoryCount {
	/** 分类名称 */
	name: string
	/** 命中数量 */
	count: number
}

/**
 * 分类聚合来源
 */
export type HardwareCategorySource =
	/** 开发板分类统计 */
	| 'boards'
	/** 库分类统计 */
	| 'libraries'

/**
 * 硬件分类聚合结果
 */
export interface HardwareCategoryResult {
	/** 分类结果来源 */
	type: HardwareCategorySource
	/** 当前统计维度 */
	dimension: string
	/** 参与统计的总条目数 */
	total: number
	/** 分类统计列表 */
	categories: Array<CategoryCount>
}

/**
 * 库索引条目
 */
export interface LibraryIndexItem {
	/** 包名或索引中的唯一名称 */
	name: string
	/** 面向用户展示的名称 */
	displayName: string
	/** 主分类 */
	category: string
	/** 支持的 core 列表 */
	supportedCores: Array<string>
	/** 通信方式或控制方式 */
	communication: Array<string>
	/** 适用工作电压列表 */
	voltage: Array<number>
	/** 对应的硬件类型标签 */
	hardwareType: Array<string>
	/** 兼容硬件列表 */
	compatibleHardware: Array<string>
	/** 搜索与归类标签 */
	tags: Array<string>
	/** 子分类 */
	subcategory?: string
	/** 对外暴露的功能摘要 */
	functions?: Array<string>
	/** 额外关键词 */
	keywords?: Array<string>
	/** 简要说明 */
	description?: string
	/** 作者信息 */
	author?: string
}

/**
 * 旧格式库条目
 */
export interface LegacyLibraryItem {
	/** 包名或唯一名称 */
	name: string
	/** 展示昵称 */
	nickname?: string
	/** 描述 */
	description?: string
	/** 关键词 */
	keywords?: Array<string>
	/** 作者 */
	author?: string
	/** 兼容性信息 */
	compatibility?: {
		/** 支持的 core 列表 */
		core?: Array<string>
	}
}

/**
 * 扩展库验证结果
 */
export interface LibraryValidationResult {
	/** 是否命中扩展库 */
	exists: boolean
	/** 命中的扩展库条目 */
	library: LegacyLibraryItem | null
	/** 是否通过模糊匹配命中 */
	fuzzyMatch: boolean
	/** 原始查询词 */
	originalQuery: string
}

/**
 * 库分类维度
 */
export type LibraryCategoryDimension =
	/** 按主分类统计 */
	| 'category'
	/** 按硬件类型统计 */
	| 'hardwareType'
	/** 按通信协议统计 */
	| 'communication'
	/** 按支持的 core 统计 */
	| 'supportedCores'

/**
 * 标签列表载荷
 */
export interface HardwareTagList {
	/** 标签列表 */
	tags?: Array<unknown>
	/** 允许保留其它字段 */
	[key: string]: unknown
}

/**
 * 索引缓存包装
 */
export type HardwareIndexCacheEnvelope<TItem, TKey extends string> = {
	/** 缓存版本 */
	version: string
	/** 生成时间 */
	generated: string
	/** 条目数量 */
	count: number
	/** 实际数据字段 */
	[key: string]: unknown
} & Record<TKey, Array<TItem>>

/**
 * 硬件搜索范围
 */
export type HardwareSearchType =
	/** 仅搜索开发板 */
	| 'boards'
	/** 仅搜索库 */
	| 'libraries'
	/** 同时搜索开发板和库 */
	| 'both'

/**
 * 结构化硬件搜索筛选条件
 */
export interface HardwareSearchFilters {
	/** 文本关键词，可与结构化筛选组合使用 */
	keywords?: string | Array<string>
	/** Flash 比较条件，例如 >4096 */
	flash?: string
	/** SRAM 比较条件，例如 >=512 */
	sram?: string
	/** 主频比较条件 */
	frequency?: string
	/** 核心数比较条件 */
	cores?: string
	/** 开发板架构筛选 */
	architecture?: string
	/** 连接能力筛选 */
	connectivity?: Array<string>
	/** 接口能力筛选 */
	interfaces?: Array<string>
	/** 品牌筛选 */
	brand?: string
	/** 电压比较条件 */
	voltage?: string
	/** 库主分类筛选 */
	category?: string
	/** 库硬件类型筛选 */
	hardwareType?: Array<string>
	/** 支持的 core 列表筛选 */
	supportedCores?: Array<string>
	/** 通信协议筛选 */
	communication?: Array<string>
}

/**
 * 硬件搜索输入参数
 */
export interface HardwareSearchQuery {
	/** 文本搜索输入 */
	query?: string | Array<string>
	/** 搜索范围 */
	type?: HardwareSearchType
	/** 结构化筛选条件 */
	filters?: HardwareSearchFilters
	/** 最大返回条目数 */
	maxResults?: number
}

/**
 * 硬件搜索结果来源
 */
export type HardwareSearchSource =
	/** 开发板结果 */
	| 'board'
	/** 库结果 */
	| 'library'

/**
 * 统一硬件搜索结果
 */
export interface HardwareSearchResult {
	/** 结果来源：开发板或库 */
	source: HardwareSearchSource
	/** 条目唯一名称 */
	name: string
	/** 面向用户展示的名称 */
	displayName: string
	/** 简要说明 */
	description: string
	/** 匹配分数 */
	score: number
	/** 命中的字段名称 */
	matchedFields: Array<string>
	/** 命中的关键词 */
	matchedQueries: Array<string>
	/** 对应的原始索引条目 */
	metadata: BoardIndexItem | LibraryIndexItem | undefined
}

/**
 * legacy 搜索兼容输入。
 */
export interface HardwareLegacySearchInput {
	/** legacy 开发板列表。 */
	legacyBoards?: Array<LegacyBoardItem>
	/** legacy 库列表。 */
	legacyLibraries?: Array<LegacyLibraryItem>
}
