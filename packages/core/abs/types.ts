/**
 * ABI JSON 转 ABS 的配置
 */
export interface AbiToAbsOptions {
	/** 是否包含注释头 */
	includeHeader?: boolean
	/** 缩进字符串 */
	indentStr?: string
	/** 是否包含块 ID 注释 */
	includeBlockIds?: boolean
	/** 是否使用显式块类型表示 */
	explicitBlockTypes?: boolean
}

/**
 * 单个块的行号范围
 */
export interface AbsBlockLineRange {
	/** 起始行号，1-based */
	startLine: number
	/** 结束行号，1-based */
	endLine: number
}

/**
 * ABI → ABS 转换结果（带行号映射）
 */
export interface AbiToAbsWithLineMapResult {
	/** 生成的 ABS 文本 */
	abs: string
	/** blockId 到行号范围的映射 */
	blockLineMap: Map<string, AbsBlockLineRange>
}

/**
 * ABS 诊断项
 */
export interface AbsDiagnostic {
	/** 行号 */
	line: number
	/** 诊断消息 */
	message: string
	/** 可选修复建议 */
	suggestion?: string
}

/**
 * ABS → ABI 转换结果
 */
export interface AbsToAbiResult<TAbiJson = unknown> {
	/** 是否转换成功 */
	success: boolean
	/** 转换后的 ABI JSON */
	abiJson?: TAbiJson
	/** 错误列表 */
	errors?: Array<AbsDiagnostic>
	/** 警告列表 */
	warnings?: Array<AbsDiagnostic>
}
