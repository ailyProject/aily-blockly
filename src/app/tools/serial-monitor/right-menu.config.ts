export let RIGHT_MENU = [
  {
    name: '复制文本',
    data: {
      type: 'window',
      path: 'project-new',
      alwaysOnTop: true,
      width: 820,
      height: 550,
    },
    icon: 'fa-light fa-copy',
  },
  {
    name: 'Hex显示',
    data: { type: 'explorer', data: 'project-open' },
    icon: 'fa-light fa-square-code',
  },
  {
    name: '高亮标记',
    action: 'project-save',
    icon: 'fa-light fa-highlighter',
  }
];
