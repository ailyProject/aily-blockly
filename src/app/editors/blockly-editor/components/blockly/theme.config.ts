import * as Blockly from 'blockly';

/** 浅色 UI 下 Blockly 工作区网格线颜色 */
export const BLOCKLY_GRID_COLOUR_LIGHT = '#ddd';
/** 深色 UI 下 Blockly 工作区网格线颜色 */
export const BLOCKLY_GRID_COLOUR_DARK = '#393939';
/** 浅色 UI 下 Blockly flyout label 文本颜色 */
export const BLOCKLY_FLYOUT_LABEL_COLOUR_LIGHT = '#404040';
/** 深色 UI 下 Blockly flyout label 文本颜色 */
export const BLOCKLY_FLYOUT_LABEL_COLOUR_DARK = '#dddddd';

export function blocklyGridColourForUiTheme(mode: 'light' | 'dark'): string {
  return mode === 'light' ? BLOCKLY_GRID_COLOUR_LIGHT : BLOCKLY_GRID_COLOUR_DARK;
}

export const DarkTheme = Blockly.Theme.defineTheme('dark', {
  name: 'dark',
  base: Blockly.Themes.Classic,
  startHats: true,
  componentStyles: {
    workspaceBackgroundColour: '#262626',
    // toolboxBackgroundColour: 'blackBackground',
    // toolboxForegroundColour: '#fff',
    flyoutBackgroundColour: '#333',
    flyoutForegroundColour: BLOCKLY_FLYOUT_LABEL_COLOUR_DARK,
    // flyoutOpacity: 1,
    // scrollbarColour: '#fff',
    scrollbarOpacity: 0.1,
    // insertionMarkerColour: '#fff',
    // insertionMarkerOpacity: 0.3,
    // markerColour: '#d0d0d0',
    // cursorColour: '#d0d0d0'
    // selectedGlowColour?: string;
    // selectedGlowOpacity?: number;
    // replacementGlowColour?: string;
    // replacementGlowOpacity?: number;
  },
});

export const LightTheme = Blockly.Theme.defineTheme('light', {
  name: 'light',
  base: Blockly.Themes.Classic,
  startHats: true,
  componentStyles: {
    workspaceBackgroundColour: '#e8e8e8',
    flyoutBackgroundColour: '#d6d6d6',
    flyoutForegroundColour: BLOCKLY_FLYOUT_LABEL_COLOUR_LIGHT,
    scrollbarOpacity: 0.3,
  },
});