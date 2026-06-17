export interface BoardIndexItem {
	name: string
	displayName: string
	brand: string
	type: 'board' | 'series'
	architecture: string
	cores: number
	frequency: number
	frequencyUnit: string
	flash: number
	sram: number
	psram: number
	connectivity: Array<string>
	interfaces: Array<string>
	core: string
	voltage: number
	mcu?: string
	gpio?: {
		digital: number
		analog: number
		pwm: number
	}
	features?: Array<string>
	tags: Array<string>
	keywords?: Array<string>
	description?: string
}

export interface LibraryIndexItem {
	name: string
	displayName: string
	category: string
	supportedCores: Array<string>
	communication: Array<string>
	voltage: Array<number>
	hardwareType: Array<string>
	compatibleHardware: Array<string>
	tags: Array<string>
	subcategory?: string
	functions?: Array<string>
	keywords?: Array<string>
	description?: string
	author?: string
}

export type HardwareSearchType = 'boards' | 'libraries' | 'both'

export interface HardwareSearchFilters {
	keywords?: string | Array<string>
	flash?: string
	sram?: string
	frequency?: string
	cores?: string
	architecture?: string
	connectivity?: Array<string>
	interfaces?: Array<string>
	brand?: string
	voltage?: string
	category?: string
	hardwareType?: Array<string>
	supportedCores?: Array<string>
	communication?: Array<string>
}

export interface HardwareSearchQuery {
	query?: string | Array<string>
	type?: HardwareSearchType
	filters?: HardwareSearchFilters
	maxResults?: number
}

export interface HardwareSearchResult {
	source: 'board' | 'library'
	name: string
	displayName: string
	description: string
	score: number
	matchedFields: Array<string>
	matchedQueries: Array<string>
	metadata: BoardIndexItem | LibraryIndexItem
}

export type BoardCategoryDimension = 'brand' | 'architecture' | 'connectivity' | 'interfaces' | 'tags'
export type LibraryCategoryDimension = 'category' | 'hardwareType' | 'communication' | 'supportedCores'

export interface CategoryCount {
	name: string
	count: number
}

export interface HardwareCategoryResult {
	type: 'boards' | 'libraries'
	dimension: string
	total: number
	categories: Array<CategoryCount>
}
