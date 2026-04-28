import * as Blockly from 'blockly';

/** 仅针对 Windows 高系统缩放下 Blockly SVG 条过宽；在首次 Blocky.inject 前调用。 */
const WINDOWS_BLOCKLY_SCROLLBAR_THICKNESS_PX = 11;

/**
 * 将 Blockly 全局滚动条厚度设为较窄的 CSS 像素，仅当运行在 Windows 时执行。
 * @see https://developers.google.com/blockly/reference/js/blockly.scrollbar_class.scrollbarthickness_property
 */
export function applyWindowsBlocklyScrollbarThickness(isWindows: boolean): void {
  if (!isWindows) return;
  const Scrollbar = (Blockly as any).Scrollbar;
  if (Scrollbar) {
    Scrollbar.scrollbarThickness = WINDOWS_BLOCKLY_SCROLLBAR_THICKNESS_PX;
  }
}
