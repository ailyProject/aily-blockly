/** coder_board_index.json 中单条开发板记录 */
export interface CoderBoardIndexEntry {
  boardId: string;
  name: string;
  package: string;
  version: string;
  type: string;
  defaultFramework: string;
  defaultPlatform: string;
  frameworkPlatforms: Array<{
    framework: string;
    platform: string;
    boardId: string;
  }>;
}

export interface CoderFrameworkOption {
  value: string;
  platform: string;
  boardId: string;
}

/** 从当前开发板记录提取可选 framework 列表（来自 frameworkPlatforms） */
export function getCoderFrameworkOptions(board: any): CoderFrameworkOption[] {
  const frameworkPlatforms = board?.frameworkPlatforms;
  if (Array.isArray(frameworkPlatforms) && frameworkPlatforms.length > 0) {
    return frameworkPlatforms
      .filter((item) => item?.framework)
      .map((item) => ({
        value: item.framework,
        platform: item.platform || '',
        boardId: item.boardId || board?.boardId || '',
      }));
  }

  const modes = Array.isArray(board?.mode) ? board.mode : [];
  return modes.map((framework: string) => ({
    value: framework,
    platform: board?.defaultPlatform || '',
    boardId: board?.boardId || '',
  }));
}

/** 按 framework 查找 frameworkPlatforms 对应项 */
export function resolveCoderFrameworkOption(board: any, framework: string): CoderFrameworkOption | undefined {
  const normalized = String(framework ?? '').trim();
  if (!normalized) {
    return undefined;
  }
  return getCoderFrameworkOptions(board).find((item) => item.value === normalized);
}

/** 选中开发板时的默认 framework：优先 defaultFramework，否则取首项 */
export function resolveDefaultCoderFramework(board: any): string {
  const options = getCoderFrameworkOptions(board);
  if (board?.defaultFramework && options.some((item) => item.value === board.defaultFramework)) {
    return board.defaultFramework;
  }
  return options[0]?.value || board?.defaultFramework || '';
}

/**
 * 将 Coder 开发板索引映射为与 boards.json 兼容的 UI 结构，
 * 便于新建项目向导复用既有筛选与展示逻辑。
 */
export function mapCoderBoardIndexToBoardList(entries: CoderBoardIndexEntry[]): any[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.map((entry) => {
    const frameworks = [
      ...new Set(
        (entry.frameworkPlatforms || [])
          .map((fp) => fp.framework)
          .filter(Boolean)
      ),
    ];
    if (entry.defaultFramework && !frameworks.includes(entry.defaultFramework)) {
      frameworks.unshift(entry.defaultFramework);
    }

    return {
      name: entry.package,
      nickname: entry.name,
      version: entry.version,
      type: entry.type || '',
      mode: frameworks.length > 0
        ? frameworks
        : entry.defaultFramework
          ? [entry.defaultFramework]
          : [],
      defaultFramework: entry.defaultFramework || '',
      defaultPlatform: entry.defaultPlatform || '',
      frameworkPlatforms: entry.frameworkPlatforms || [],
      boardId: entry.boardId || '',
      brand: '',
      description: '',
      img: '',
      pinmap: '',
      url: '',
      state: '',
      keywords: '',
      compatibility: '',
      author: '',
    };
  });
}
