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
 * ABS 变量定义
 */
export interface AbsVariableDefinition {
	/** 变量名 */
	name: string
	/** 变量类型 */
	type: string
	/** 初始值文本 */
	initialValue?: string
}

/**
 * ABS 语法节点
 */
export interface AbsNode {
	/** 块类型 */
	type: string
	/** 字段值映射 */
	fields: Record<string, unknown>
	/** 输入槽位映射 */
	inputs: Record<string, AbsNode | Array<AbsNode>>
	/** next 链子节点 */
	children: Array<AbsNode>
	/** 缩进级别 */
	indent: number
	/** 源文本行号 */
	lineNumber: number
	/** 原始行文本 */
	raw: string
	/** 额外 mutator 状态 */
	extraState?: Record<string, unknown>
}

/**
 * ABS 语法糖解析结果
 */
export interface AbsSyntaxSugarResult {
	/** 目标块类型 */
	type: string
	/** 字段映射 */
	fields?: Record<string, unknown>
	/** 输入映射 */
	inputs?: Record<string, unknown>
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
 * ABI → ABS 转换结果（带行号映射）
 */
export interface AbiToAbsWithLineMapResult {
	/** 生成的 ABS 文本 */
	abs: string
	/** blockId 到行号范围的映射 */
	blockLineMap: Map<string, AbsBlockLineRange>
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

/**
 * ABS 解析结果
 */
export interface AbsParseResult<TRootBlock = unknown> {
	/** 是否解析成功 */
	success: boolean
	/** 解析出的变量定义 */
	variables: Array<AbsVariableDefinition>
	/** 根块配置列表 */
	rootBlocks: Array<TRootBlock>
	/** 错误列表 */
	errors: Array<AbsDiagnostic>
	/** 警告列表 */
	warnings: Array<AbsDiagnostic>
}
