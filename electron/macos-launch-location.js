// macOS 从 DMG 或尚未移动的隔离副本直接打开时，系统会把应用转到只读的
// AppTranslocation 临时目录；内置 Node/npm 在该位置无法正常加载。
const path = require('path');

const GUIDE_CHANNEL = 'macos-install-guide';

function pathSegments(value) {
  return String(value || '').split(/[/\\]/).filter(Boolean);
}

function isAppTranslocationPath(value) {
  return typeof value === 'string' && pathSegments(value).includes('AppTranslocation');
}

function isDiskImageAppPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/Volumes/')) return false;
  if (pathSegments(value).includes('Applications')) return false;
  return /\.app(?:\/|$)/.test(value);
}

const PRODUCTS = {
  blockly: { appName: 'aily blockly', bundleName: 'aily blockly' },
  coder: { appName: 'Aily Coder', bundleName: 'aily coder' },
};

function normalizeProduct(product) {
  return String(product || '').trim().toLowerCase() === 'coder' ? 'coder' : 'blockly';
}

function bundleNameFromPaths(paths) {
  for (const value of paths) {
    const match = String(value).match(/([^/\\]+)\.app(?:[/\\]|$)/);
    if (match) return match[1];
  }
  return '';
}

function guideCopy(locale, appName, bundleName) {
  const bundle = `${bundleName}.app`;
  if (String(locale || '').toLowerCase().startsWith('zh')) {
    return {
      lang: 'zh-CN',
      title: `请先将 ${appName} 安装到「应用程序」`,
      reason: '开发板安装和编译需要应用内置的运行环境，安装到「应用程序」后才能正常使用。',
      stepsTitle: '请按以下步骤安装后重新启动',
      steps: [
        `退出当前的 ${appName}。`,
        `打开下载的 DMG 安装镜像，将「${bundle}」拖入「应用程序（Applications）」文件夹，等待复制完成。`,
        `推出安装镜像，然后在 Finder 的「应用程序」中启动 ${appName}。`,
        '重新打开项目，重试开发板安装和编译。',
      ],
      sourceLabel: 'DMG 安装镜像',
      targetLabel: '应用程序',
      locationLabel: '当前运行位置',
      openApplications: '打开「应用程序」文件夹',
      quit: '退出',
    };
  }
  return {
    lang: 'en',
    title: `Move ${appName} to Applications first`,
    reason: 'Board installation and compilation rely on the app’s built-in runtime, which only works after the app is installed in Applications.',
    stepsTitle: 'Install it with these steps, then launch it again',
    steps: [
      `Quit ${appName}.`,
      `Open the downloaded DMG and drag “${bundle}” into the Applications folder. Wait until copying finishes.`,
      `Eject the disk image, then launch ${appName} from Applications in Finder.`,
      'Reopen your project and retry board installation and compilation.',
    ],
    sourceLabel: 'Disk image',
    targetLabel: 'Applications',
    locationLabel: 'Current location',
    openApplications: 'Open Applications Folder',
    quit: 'Quit',
  };
}

function inspectMacosLaunchLocation({ platform, paths = [], appName, product, locale } = {}) {
  const candidates = paths.filter(value => typeof value === 'string' && value.trim());
  const productId = normalizeProduct(product);
  const defaults = PRODUCTS[productId];
  const name = (typeof appName === 'string' && appName.trim()) || defaults.appName;
  const base = { product: productId, appName: name, evidencePath: '' };
  if (platform !== 'darwin') return { ...base, unsafe: false, status: 'not-applicable' };

  const translocated = candidates.find(isAppTranslocationPath) || '';
  const evidencePath = translocated || candidates.find(isDiskImageAppPath) || '';
  if (!evidencePath) return { ...base, unsafe: false, status: 'ok' };

  const bundleName = bundleNameFromPaths([evidencePath]) || defaults.bundleName;
  return {
    ...base,
    unsafe: true,
    status: translocated ? 'app-translocation' : 'disk-image',
    evidencePath,
    bundleName,
    copy: guideCopy(locale, name, bundleName),
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function isSafeImageDataUrl(value) {
  return typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value);
}

function diskImageIcon(appIcon) {
  const app = isSafeImageDataUrl(appIcon)
    ? `<image href="${appIcon}" x="27" y="2" width="50" height="50"/>`
    : '';
  return `<svg viewBox="0 0 104 104" role="img">
    <defs>
      <linearGradient id="dmg-body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfbfc"/><stop offset="1" stop-color="#d3d6dc"/></linearGradient>
      <linearGradient id="dmg-top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eceef1"/></linearGradient>    </defs>
    <path d="M18 46 H86 L94 66 V84 Q94 92 86 92 H18 Q10 92 10 84 V66 Z" fill="url(#dmg-body)" stroke="rgba(0,0,0,.14)"/>
    <path d="M18 46 H86 L94 66 H10 Z" fill="url(#dmg-top)" stroke="rgba(0,0,0,.08)"/>
    <path d="M14 78 H90" stroke="rgba(0,0,0,.09)"/>
    <rect x="70" y="82" width="14" height="3" rx="1.5" fill="#9aa0a8"/>
    ${app}
  </svg>`;
}

function applicationsFolderIcon() {
  return `<svg viewBox="0 0 104 104" role="img">
    <defs>
      <linearGradient id="folder-back" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5fb0f6"/><stop offset="1" stop-color="#3f8fe3"/></linearGradient>
      <linearGradient id="folder-front" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fd0ff"/><stop offset="1" stop-color="#56a8f2"/></linearGradient>
    </defs>
    <path d="M10 26 Q10 18 18 18 H40 Q45 18 48 22 L52 27 H86 Q94 27 94 35 V44 H10 Z" fill="url(#folder-back)"/>
    <rect x="8" y="34" width="88" height="58" rx="9" fill="url(#folder-front)"/>
    <path d="M17 35.5 H87" stroke="rgba(255,255,255,.55)" stroke-width="1.5" stroke-linecap="round"/>
    <g fill="none" stroke-linecap="round" stroke-width="5.5">
      <g stroke="rgba(255,255,255,.4)" transform="translate(0 1.2)">
        <path d="M41 78 L52 51"/><path d="M63 78 L52 51"/><path d="M36 70 H68"/>
      </g>
      <g stroke="#2f7fd4" opacity=".75">
        <path d="M41 78 L52 51"/><path d="M63 78 L52 51"/><path d="M36 70 H68"/>
      </g>
    </g>
  </svg>`;
}

function renderInstallGuideHtml(report, appIcon) {
  const copy = report.copy;
  const steps = copy.steps.map((step, index) => `
        <li><span class="index">${index + 1}</span><span>${escapeHtml(step)}</span></li>`).join('');
  return `<!doctype html>
<html lang="${copy.lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(copy.title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f6f8; --card: #ffffff; --text: #1d1f23; --muted: #626872; --line: #e3e5ea;
    --accent: #2f6bff; --accent-soft: rgba(47, 107, 255, .1); --warn: #d4380d; --warn-soft: rgba(212, 56, 13, .1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17181b; --card: #212328; --text: #eceef2; --muted: #9aa0aa; --line: #32353c;
      --accent: #6c95ff; --accent-soft: rgba(108, 149, 255, .14); --warn: #ff7a45; --warn-soft: rgba(255, 122, 69, .14);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; background: var(--card); color: var(--text);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  .titlebar { height: 38px; flex: none; -webkit-app-region: drag; }
  main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 0 56px 36px; }
  .card { width: 100%; max-width: 760px; }
  .visual { display: flex; align-items: center; justify-content: center; gap: 22px; margin-bottom: 24px; }
  .tile { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
  .tile svg { width: 104px; height: 104px; filter: drop-shadow(0 6px 10px rgba(0, 0, 0, .18)); }
  .arrow { width: 108px; height: 24px; color: var(--accent); }
  .arrow svg { width: 100%; height: 100%; }
  .arrow .flow { stroke-dasharray: 4 7; animation: flow 1.2s linear infinite; }
  @keyframes flow { to { stroke-dashoffset: -11; } }
  @media (prefers-reduced-motion: reduce) { .arrow .flow { animation: none; } }
  h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.35; text-align: center; }
  .reason {
    margin: 0 0 24px; padding: 12px 14px; border-radius: 10px; background: var(--warn-soft);
    color: var(--text); font-size: 13px;
  }
  .reason strong { color: var(--warn); }
  h2 { margin: 0 0 12px; font-size: 14px; color: var(--muted); font-weight: 600; }
  ol { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
  li { display: flex; gap: 12px; align-items: flex-start; }
  .index {
    flex: none; display: grid; place-items: center; width: 22px; height: 22px; margin-top: 1px; border-radius: 50%;
    background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 700;
  }
  .location {
    margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--muted);
    font-size: 11px; word-break: break-all; -webkit-user-select: text; user-select: text;
  }
  .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
  button {
    height: 34px; padding: 0 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--card);
    color: var(--text); font: inherit; font-size: 13px; cursor: pointer;
  }
  button.primary { border-color: transparent; background: var(--accent); color: #fff; }
  button:hover { filter: brightness(1.06); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>
  <div class="titlebar"></div>
  <main>
    <section class="card" role="alertdialog" aria-labelledby="title" aria-describedby="reason">
      <div class="visual" aria-hidden="true">
        <div class="tile">${diskImageIcon(appIcon)}${escapeHtml(copy.sourceLabel)}</div>
        <div class="arrow"><svg viewBox="0 0 108 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path class="flow" d="M4 12 H92"/><path d="M90 5 L100 12 L90 19"/></svg></div>
        <div class="tile">${applicationsFolderIcon()}${escapeHtml(copy.targetLabel)}</div>
      </div>
      <h1 id="title">${escapeHtml(copy.title)}</h1>
      <p class="reason" id="reason"><strong>!</strong> ${escapeHtml(copy.reason)}</p>
      <h2>${escapeHtml(copy.stepsTitle)}</h2>
      <ol>${steps}
      </ol>
      <div class="location">${escapeHtml(copy.locationLabel)}：${escapeHtml(report.evidencePath)}</div>
      <div class="actions">
        <button type="button" data-action="open-applications">${escapeHtml(copy.openApplications)}</button>
        <button type="button" class="primary" data-action="quit" autofocus>${escapeHtml(copy.quit)}</button>
      </div>
    </section>
  </main>
  <script>
    document.addEventListener('click', event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action) window.installGuide?.send(action);
    });
    document.addEventListener('contextmenu', event => event.preventDefault());
  </script>
</body>
</html>`;
}

function showMacosInstallGuide({ BrowserWindow, ipcMain, shell, app, nativeImage, nativeTheme, report, log = console.error }) {
  log(`[macos-launch] ${report.status}: ${report.evidencePath}`);
  const win = new BrowserWindow({
    width: 880,
    height: 700,
    minWidth: 720,
    minHeight: 660,
    backgroundColor: nativeTheme?.shouldUseDarkColors ? '#212328' : '#ffffff',
    show: false,
    title: report.copy.title,
    titleBarStyle: 'hiddenInset',
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'macos-install-guide-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      spellcheck: false,
    },
  });

  const onAction = (event, action) => {
    if (event.sender !== win.webContents) return;
    if (action === 'open-applications') {
      void Promise.resolve(shell.openPath('/Applications')).then(error => {
        if (error) log(`[macos-launch] 无法打开「应用程序」文件夹: ${error}`);
      });
    } else if (action === 'quit') {
      app.quit();
    }
  };
  ipcMain.on(GUIDE_CHANNEL, onAction);
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    ipcMain.removeListener(GUIDE_CHANNEL, onAction);
    app.quit();
  });
  void loadAppIcon({ nativeImage, app, evidencePath: report.evidencePath, log }).then(appIcon => {
    if (win.isDestroyed()) return;
    return win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderInstallGuideHtml(report, appIcon))}`);
  }).catch(error => log(`[macos-launch] 安装引导页加载失败: ${error?.message || error}`));
  return win;
}

// 图标取自当前运行的 .app，Blockly 与 Coder 各自显示打包时写入的应用图标。
async function loadAppIcon({ nativeImage, app, evidencePath, log = () => {} }) {
  const bundle = String(evidencePath || '').match(/^(.*?\.app)(?:\/|$)/)?.[1];
  if (!bundle) return '';
  const withTimeout = promise => Promise.race([promise, new Promise(resolve => setTimeout(resolve, 1500, null))]);
  const sources = [
    () => nativeImage?.createThumbnailFromPath?.(bundle, { width: 256, height: 256 }),
    () => nativeImage?.createFromPath?.(path.join(bundle, 'Contents', 'Resources', 'icon.icns')),
    () => app?.getFileIcon?.(bundle, { size: 'normal' }),
  ];
  for (const source of sources) {
    try {
      const image = await withTimeout(Promise.resolve(source()));
      if (image && !image.isEmpty()) return image.toDataURL();
    } catch { /* 尝试下一种读取方式 */ }
  }
  log(`[macos-launch] 未能读取应用图标: ${bundle}`);
  return '';
}

module.exports = {
  GUIDE_CHANNEL,
  inspectMacosLaunchLocation,
  renderInstallGuideHtml,
  showMacosInstallGuide,
  loadAppIcon,
  isAppTranslocationPath,
  isDiskImageAppPath,
};
