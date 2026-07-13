/**
 * Mermaid 暗色主题配置。
 * 适用于流程图等图表，与暗系 IDE 风格一致。
 *
 * 颜色说明：
 * - 图表背景: #333333
 * - 节点填充: #404040
 * - 节点边框/连接线: #888888
 * - 节点文字: #FFFFFF
 * - 边标签背景: hsl(0, 0%, 34.41%) ≈ #585858
 *
 * @example
 * ```ts
 * import mermaid from 'mermaid';
 * import { MERMAID_DARK_THEME } from 'ngx-x-markdown';
 * MermaidCodeComponent.setMermaidInstance(mermaid, MERMAID_DARK_THEME);
 * ```
 */
export const MERMAID_DARK_THEME = {
  theme: 'base',
  themeVariables: {
    darkMode: true,
    background: '#333333',
    primaryColor: '#404040',
    primaryTextColor: '#FFFFFF',
    primaryBorderColor: '#888888',
    lineColor: '#888888',
    secondaryColor: '#404040',
    secondaryBorderColor: '#888888',
    tertiaryColor: '#404040',
    tertiaryBorderColor: '#888888',
    edgeLabelBackground: '#585858',
  },
} as const;
