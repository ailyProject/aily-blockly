export const PYTHON_PROJECT_ENTRY = 'main.py';

export const LINUX_BOARD_CONNECTORS = ['ssh', 'serial'] as const;

export type LinuxBoardConnector = typeof LINUX_BOARD_CONNECTORS[number];

export interface LinuxBoardProjectRoute {
  mode: 'python';
  entry: string;
}

export interface LinuxBoardExecutionRoute extends LinuxBoardProjectRoute {
  connectors: LinuxBoardConnector[];
}

/** 规范化项目清单中的开发模式；缺失值由调用方按兼容策略回退到 Arduino。 */
export function normalizeProjectMode(packageData: unknown): string {
  const project = asRecord(packageData);
  return String(project?.['devmode'] || '').trim().toLowerCase();
}

export function resolveLinuxBoardProjectRoute(
  packageData: unknown,
): LinuxBoardProjectRoute | null {
  // 代码生成只服从 package.json.devmode，不依赖板卡或连接状态，因此 Python 项目离线时也能生成 main.py。
  if (normalizeProjectMode(packageData) !== 'python') return null;

  return {
    mode: 'python',
    entry: PYTHON_PROJECT_ENTRY,
  };
}

/** 规范化 boards.json.mode，用于判断目标板是否能执行当前 Python 项目。 */
export function normalizeBoardModes(boardData: unknown): string[] {
  const board = asRecord(boardData);
  const modes = board?.['mode'];
  if (!Array.isArray(modes)) return [];
  return modes
    .filter((mode): mode is string => typeof mode === 'string')
    .map(mode => mode.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Blockly 切板只能选择与当前项目 devmode 一致的开发板。
 * 历史 Arduino 板未声明 mode，按 arduino 处理。
 */
export function isBoardCompatibleWithProjectMode(
  boardData: unknown,
  packageData: unknown,
): boolean {
  const projectMode = normalizeProjectMode(packageData) || 'arduino';
  const declaredModes = normalizeBoardModes(boardData);
  const boardModes = declaredModes.length > 0 ? declaredModes : ['arduino'];
  return boardModes.includes(projectMode);
}

/** 读取 Linux 板支持的执行连接器；Arduino 板没有该字段时返回空列表。 */
export function normalizeBoardConnectors(
  boardData: unknown,
): LinuxBoardConnector[] {
  const board = asRecord(boardData);
  if (!Array.isArray(board?.['connector'])) return [];
  const connectors = board['connector']
    .filter((connector): connector is string => typeof connector === 'string')
    .map(connector => connector.trim().toLowerCase())
    .filter((connector): connector is LinuxBoardConnector => (
      (LINUX_BOARD_CONNECTORS as readonly string[]).includes(connector)
    ));
  return [...new Set(connectors)];
}

export function resolveLinuxBoardExecutionRoute(
  packageData: unknown,
  boardData: unknown,
): LinuxBoardExecutionRoute | null {
  // Linux 执行必须同时满足“Python 项目 + Python 板卡 + 有效连接器”；不满足时返回 null，交回 Arduino 原路径。
  const projectRoute = resolveLinuxBoardProjectRoute(packageData);
  if (!projectRoute || !normalizeBoardModes(boardData).includes(projectRoute.mode)) {
    return null;
  }
  const connectors = normalizeBoardConnectors(boardData);
  if (connectors.length === 0) return null;
  return { ...projectRoute, connectors };
}

export function resolveLinuxBoardConnectorSelection(
  connectors: readonly LinuxBoardConnector[],
  selected: LinuxBoardConnector | null | undefined,
): LinuxBoardConnector | null {
  // 单连接器板可直接选中；双连接器板必须保留用户的显式选择，避免猜测 SSH 或串口。
  if (selected) return connectors.includes(selected) ? selected : null;
  return connectors.length === 1 ? connectors[0] : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
