/**
 * 代码编辑器页面展示状态
 */
export interface CodeEditorState {
	/** 当前 lint 运行模式 */
	lintMode: string
	/** 当前错误数量 */
	errorCount: number
	/** 当前警告数量 */
	warningCount: number
	/** 当前 lint 执行耗时 */
	executionTime: number
	/** 当前 ABI 中解析出的块数量 */
	parsedBlockCount: number
	/** 当前 ABI 序列化后的文本长度 */
	stringifiedLength: number
}
