/**
 * 仿真器页面展示状态
 */
export interface SimulatorState {
	/** 兼容匹配数量 */
	matchCount: number
	/** 命中的开发板显示名称 */
	boardNames: Array<string>
	/** 当前板卡接口维度 */
	interfaceNames: Array<string>
}
