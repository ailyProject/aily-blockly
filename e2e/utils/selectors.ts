/**
 * 集中化选择器。渲染端组件请配合添加同名 data-testid。
 * 约定：命名采用 kebab-case，前缀按模块：
 *   - window-* 窗口控制
 *   - menu-*   菜单
 *   - new-project-* 新建项目
 *   - blockly-*     Blockly 编辑器
 *   - serial-*      串口
 *   - settings-*    设置
 *   - chat-*        AI chat
 */

export const sel = {
  // 窗口
  windowMinimize: '[data-testid="window-minimize"]',
  windowMaximize: '[data-testid="window-maximize"]',
  windowClose: '[data-testid="window-close"]',

  // 主菜单 / 启动页
  menuNewProject: '[data-testid="menu-new-project"]',
  menuOpenProject: '[data-testid="menu-open-project"]',
  guideSkipBtn: '[data-testid="guide-skip"]',

  // 新建项目向导
  newProjectName: '[data-testid="new-project-name"]',
  newProjectBoardInput: '[data-testid="new-project-board-input"]',
  newProjectBoardOption: (boardId: string) =>
    `[data-testid="new-project-board-option"][data-board-id="${boardId}"]`,
  newProjectBoardOptionAny: '[data-testid="new-project-board-option"]:not(.disabled)',
  newProjectUseThis: '[data-testid="new-project-use-this"]',
  newProjectSelectFolder: '[data-testid="new-project-select-folder"]',
  newProjectSubmit: '[data-testid="new-project-submit"]',

  // Blockly 编辑器
  blocklyWorkspace: '[data-testid="blockly-workspace"]',
  blocklyToolbox: '.blocklyToolboxDiv',
  btnBuild: '[data-testid="btn-build"]',
  btnUpload: '[data-testid="btn-upload"]',
  codePreview: '[data-testid="code-preview"]',
  // build-status 与 btn-build 是同一个元素：app-act-btn 同时挂载 data-testid 和 data-build-status
  buildStatus: '[data-testid="btn-build"]',
  // upload-status 与 btn-upload 是同一个元素：app-act-btn 同时挂载 data-testid 和 data-upload-status
  uploadStatus: '[data-testid="btn-upload"]',

  // 串口
  serialPortSelect: '[data-testid="serial-port-select"]',
  serialBaudSelect: '[data-testid="serial-baud-select"]',
  serialConnectBtn: '[data-testid="serial-connect"]',
  serialOutput: '[data-testid="serial-output"]',

  // 设置
  settingsTab: (name: string) => `[data-testid="settings-tab-${name}"]`,
  langSelect: '[data-testid="lang-select"]',
  themeSelect: '[data-testid="theme-select"]',

  // AI Chat
  chatInput: '[data-testid="chat-input"]',
  chatSendBtn: '[data-testid="chat-send"]',
  chatMessageList: '[data-testid="chat-message-list"]',
} as const;
