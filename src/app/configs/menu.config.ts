export interface IMenuItem {
  name?: string;
  text?: string;
  action?: string;
  type?: string;
  data?: any;
  icon?: string;
  color?: string;
  more?: string;
  sep?: boolean;
  state?: 'default' | 'doing' | 'done' | 'error' | 'warn';
  disabled?: boolean;
  dev?: boolean;
  router?: string[]; // 在指定路由中显示
  children?: IMenuItem[],
  check?: boolean,
  key?: string; // 用于标识编译和上传配置
}

export let HEADER_BTNS: IMenuItem[][] = [
  [
    {
      name: 'MENU.BUILD',
      action: 'compile',
      data: { type: 'cmd', data: 'compile' },
      icon: 'fa-regular fa-check',
      type: 'act-btn',
      color: '#006adc',
      state: 'default',
      router: ['/main/blockly-editor', '/main/code-editor']
    },
    {
      name: 'MENU.RUN',
      action: 'upload',
      data: { type: 'cmd', data: 'upload' },
      icon: 'fa-regular fa-play',
      type: 'act-btn',
      color: '#009600',
      state: 'default',
      router: ['/main/blockly-editor', '/main/code-editor']
    },
    // {
    //   name: 'MENU.DEBUG',
    //   data: { type: 'cmd', data: 'debug' },
    //   icon: 'fa-regular fa-rocket',
    //   type: 'act-btn',
    //   color: '#f18800',
    // },
  ],
  [
    // {
    //   name: 'MENU.TERMINAL',
    //   action: 'terminal',
    //   data: { type: 'terminal', data: "default" },
    //   icon: 'fa-light fa-rectangle-terminal',
    // },
    {
      name: 'MENU.CODE',
      action: 'tool-open',
      data: { type: 'tool', data: "code-viewer" },
      icon: 'fa-light fa-rectangle-code',
      router: ['/main/blockly-editor']
    },
    {
      name: 'MENU.TOOL_SERIAL',
      action: 'tool-open',
      data: { type: 'tool', data: "serial-monitor" },
      icon: 'fa-light fa-monitor-waveform',
    },
    {
      name: 'MENU.SIMULATOR',
      action: 'tool-open',
      data: { type: 'tool', data: "simulator" },
      icon: 'fa-light fa-atom',
      dev: true,
      router: ['/main/blockly-editor']
    },
    {
      name: 'MENU.AI',
      action: 'tool-open',
      data: { type: 'tool', data: "aily-chat" },
      icon: 'fa-light fa-star-christmas',
      more: 'AI',
      dev: true
    },
    {
      name: 'MENU.APP_STORE',
      action: 'tool-open',
      data: { type: 'tool', data: "app-store" },
      icon: 'fa-light fa-store',
      dev: true
    },
    {
      name: 'MENU.USER',
      action: 'user-auth',
      data: { type: 'tool', data: "app-store" },
      icon: 'fa-light fa-user',
      dev: true
    },
  ],
];


export let HEADER_MENU: IMenuItem[] = [
  {
    name: 'MENU.PROJECT_NEW',
    text: 'Ctrl + N',
    action: 'project-new',
    data: { type: 'project-new', path: 'project-new', alwaysOnTop: true, width: 820, height: 550 },
    icon: 'fa-light fa-file-circle-plus',
  },
  {
    name: 'MENU.PROJECT_OPEN',
    text: 'Ctrl + O',
    action: 'project-open',
    data: { type: 'project-open', data: 'project-open' },
    icon: 'fa-light fa-folder-open',
  },
  {
    name: 'MENU.PROJECT_SAVE',
    text: 'Ctrl + S',
    action: 'project-save',
    data: { type: 'cmd', data: 'save' },
    icon: 'fa-light fa-file-circle-check',
    router: ['/main/blockly-editor', '/main/code-editor']
  },
  {
    name: 'MENU.PROJECT_SAVE_AS',
    text: 'Ctrl + Shift + S',
    action: 'project-save-as',
    data: { type: 'cmd', data: 'save-as' },
    icon: 'fa-light fa-copy',
    router: ['/main/blockly-editor', '/main/code-editor']
  },
  {
    name: 'MENU.OPEN_IN_EXPLORER',
    action: 'project-open-by-explorer',
    data: { type: 'other', action: 'openByExplorer', data: 'project' },
    icon: 'fa-light fa-browser',
    router: ['/main/blockly-editor', '/main/code-editor']
  },
  {
    name: 'MENU.PROJECT_CLOSE',
    action: 'project-close',
    data: { type: 'cmd', data: 'close' },
    icon: 'fa-light fa-folder-closed',
    router: ['/main/blockly-editor', '/main/code-editor']
  },
  // {
  //   name: 'MENU.CODE_EXPORT',
  //   action: 'code-export',
  //   icon: 'fa-light fa-square-code',
  // },
  {
    sep: true,
  },
  {
    name: 'MENU.SETTINGS',
    action: 'settings-open',
    data: { type: 'window', path: 'settings', alwaysOnTop: true, width: 700, height: 550 },
    icon: 'fa-light fa-gear',
  },
  {
    name: 'MENU.UPDATE',
    action: 'check-update',
    icon: 'fa-light fa-cloud-arrow-down',
  },
  {
    sep: true,
  },
  {
    name: 'MENU.EXAMPLES',
    action: 'example-open',
    icon: 'fa-light fa-books',
  },
  {
    name: 'MENU.ABOUT',
    action: 'browser-open',
    data: { type: 'other', action: 'openByBrowser', url: 'https://aily.pro' },
    icon: 'fa-light fa-globe-pointer',
  },
  {
    name: 'MENU.GITHUB',
    action: 'browser-open',
    data: { type: 'other', action: 'openByBrowser', url: 'https://github.com/ailyProject/aily-blockly' },
    icon: 'fa-brands fa-github-alt',
  },
  {
    sep: true,
  },
  {
    name: 'MENU.EXIT',
    action: 'app-exit',
    data: { type: 'other', action: 'exitApp' },
    icon: 'fa-light fa-xmark',
  },
];

export let GUIDE_MENU: IMenuItem[] = [
  {
    name: 'MENU.PROJECT_NEW',
    action: 'project-new',
    data: { type: 'project-new', path: 'project-new', alwaysOnTop: true, width: 820, height: 550 },
    icon: 'fa-light fa-file-circle-plus',
  },
  {
    name: 'MENU.PROJECT_OPEN',
    action: 'project-open',
    data: { type: 'explorer', data: 'project-open' },
    icon: 'fa-light fa-folder-open',
  },
  {
    name: 'MENU.USER_MANUAL',
    action: 'browser-open',
    data: { type: 'other', action: 'openByBrowser', url: 'https://aily.pro/doc' },
    icon: 'fa-light fa-book-open-cover',
  },
  {
    name: 'MENU.EXAMPLES',
    action: 'playground-open',
    data: { type: 'other', action: 'openByBrowser', url: 'https://aily.pro' },
    icon: 'fa-light fa-books',
  }
];


export let FOOTER_BTNS: IMenuItem[] = [
  {
    name: 'MENU.PROJECT_NEW',
    text: '日志',
    action: 'log-open',
    icon: 'fa-light fa-square-list',
  },
  {
    name: 'MENU.TERMINAL',
    text: '终端',
    action: 'terminal-open',
    icon: 'fa-light fa-square-terminal',
  }
]