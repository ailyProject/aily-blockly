import type { TerminalViewportSize } from './types'

const MIN_TERMINAL_COLS = 40
const MIN_TERMINAL_ROWS = 12

const resolveLineHeight = (style: CSSStyleDeclaration) => {
	const numeric = Number.parseFloat(style.lineHeight)
	if (Number.isFinite(numeric) && numeric > 0) return numeric
	return Number.parseFloat(style.fontSize) * 1.55
}

const resolveCharWidth = (style: CSSStyleDeclaration) => {
	const canvas = document.createElement('canvas')
	const context = canvas.getContext('2d')
	if (!context) return Number.parseFloat(style.fontSize) * 0.62

	context.font = style.font
	const width = context.measureText('0').width
	return width > 0 ? width : Number.parseFloat(style.fontSize) * 0.62
}

/**
 * 根据终端输出容器的像素尺寸估算字符网格。
 * @param element - 终端输出容器
 */
export const measureTerminalViewport = (element: HTMLElement): TerminalViewportSize => {
	const style = getComputedStyle(element)
	const paddingX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
	const paddingY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
	const innerWidth = Math.max(0, element.clientWidth - paddingX)
	const innerHeight = Math.max(0, element.clientHeight - paddingY)
	const charWidth = resolveCharWidth(style)
	const lineHeight = resolveLineHeight(style)

	return {
		cols: Math.max(MIN_TERMINAL_COLS, Math.floor(innerWidth / Math.max(charWidth, 1))),
		rows: Math.max(MIN_TERMINAL_ROWS, Math.floor(innerHeight / Math.max(lineHeight, 1)))
	}
}
