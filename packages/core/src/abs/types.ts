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
 * 块参数在声明中的类别。
 */
export type AbsBlockArgKind = 'field' | 'valueInput' | 'statementInput'

/**
 * 块参数顺序项。
 */
export interface AbsBlockArgOrderEntry {
	/** 参数名。 */
	name: string
	/** 参数类别。 */
	kind: AbsBlockArgKind
}

/**
 * ABS / ABI 转换时使用的块元数据。
 */
export interface AbsBlockMeta {
	/** 块类型。 */
	type: string
	/** 字段名列表。 */
	fieldNames: Array<string>
	/** 字段类型映射。 */
	fieldTypes: Map<string, string>
	/** 值输入名称列表。 */
	valueInputNames: Array<string>
	/** 语句输入名称列表。 */
	statementInputNames: Array<string>
	/** 是否存在语句输入。 */
	hasStatementInput?: boolean
	/** 所有参数的原始顺序。 */
	argsOrder: Array<AbsBlockArgOrderEntry>
	/** 是否有输出。 */
	hasOutput: boolean
	/** 输出类型定义。 */
	outputType?: string | Array<string>
	/** 是否有 previousStatement。 */
	hasPrevious: boolean
	/** 是否有 nextStatement。 */
	hasNext: boolean
	/** 是否可作为根块。 */
	isRootBlock: boolean
	/** 是否是简单值块。 */
	isValueBlock?: boolean
	/** 所属库包名。 */
	library: string
	/** mutator 名称。 */
	mutator?: string
}

/**
 * ABS 解析后的中间块配置。
 */
export interface AbsBlockConfig {
	/** 块类型。 */
	type: string
	/** 可选序列化 ID。 */
	id?: string
	/** 字段映射。 */
	fields?: Record<string, unknown>
	/** 输入映射。 */
	inputs?: Record<string, { block?: AbsBlockConfig; shadow?: AbsBlockConfig }>
	/** Blockly 画布位置。 */
	position?: {
		x: number
		y: number
	}
	/** next 链。 */
	next?: {
		block: AbsBlockConfig
	}
	/** mutator / extraState。 */
	extraState?: Record<string, unknown>
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
