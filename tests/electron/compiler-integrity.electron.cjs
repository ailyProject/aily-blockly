'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const repo = path.resolve(__dirname, '../..');
fs.mkdirSync(path.join(repo, 'tests/.artifacts'), { recursive: true });
const output = process.env.AILY_COMPILER_BRIDGE_OUTPUT || fs.mkdtempSync(path.join(repo, 'tests/.artifacts/compiler-bridge-'));
if (!process.versions.electron) {
  const environment = { ...process.env, AILY_COMPILER_BRIDGE_OUTPUT: output, AILY_APPDATA_PATH: path.join(output, 'appdata'), AILY_CHILD_PATH: path.join(repo, 'child') };
  delete environment.ELECTRON_RUN_AS_NODE; delete environment.NODE_PATH;
  const result = spawnSync(require('electron'), [__filename], { cwd: repo, env: environment, encoding: 'utf8', timeout: 30000 });
  fs.writeFileSync(path.join(output, 'stderr.log'), result.stderr || '');
  process.stdout.write(result.stdout || '');
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(output, 'profile'));
  fs.mkdirSync(process.env.AILY_APPDATA_PATH, { recursive: true });
  const empty = path.join(output, 'empty-compiler'); fs.mkdirSync(empty, { recursive: true });
  const base = process.env.AILY_COMPILER_SOURCE_APPDATA || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/aily-project' : 'AppData/Local/aily-project');
  const compiler = path.join(base, 'tools/esp-x32@14.2.0');
  const code = ts.transpileModule(fs.readFileSync(path.join(repo, 'src/app/utils/compiler-integrity.utils.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: false, contextIsolation: true, preload: path.join(repo, 'electron/preload.js') } });
    let preloadError;
    window.webContents.on('preload-error', (_event, _path, error) => { preloadError = error.message; });
    try {
      await window.loadURL('data:text/html,<html><body>Compiler integrity bridge regression</body></html>');
      if (preloadError) throw new Error(preloadError);
      const result = await window.webContents.executeJavaScript(`(() => {
        try {
        const exports = {}; ${code}
        const api = window.electronAPI;
        const check = directory => exports.findCompilerIntegrityProblem('@aily-project/compiler-esp-x32', directory, api.fs, api.path.join, api.platform.isWindows);
        let missingError;
        try { api.fs.statSync(${JSON.stringify(empty + '/missing')}); } catch (error) { missingError = { code: error.code, message: error.message }; }
        const firstStart = performance.now();
        const healthy = check(${JSON.stringify(compiler)});
        const firstCheckMs = performance.now() - firstStart;
        const missing = check(${JSON.stringify(empty)});
        const layouts = ${JSON.stringify(['arm-none-eabi-gcc@4.8.3', 'arm-none-eabi-gcc@7.2.1', 'avr-gcc@7.3.0', 'esp-rv32@14.2.0', 'pqt-gcc@4.1.0', 'riscv-gcc@9.2.0', 'xpack-arm-none-eabi-gcc@14.2.1'])}
          .filter(entry => api.path.isExists(api.path.join(${JSON.stringify(base)}, 'tools', entry)))
          .map(entry => ({ entry, problem: exports.findCompilerIntegrityProblem('@aily-project/compiler-' + entry.split('@')[0],
            api.path.join(${JSON.stringify(base)}, 'tools', entry), api.fs, api.path.join, api.platform.isWindows) }));
        const values = [];
        for (let i = 0; i < 500; i++) { const start = performance.now(); check(${JSON.stringify(compiler)}); values.push(performance.now() - start); }
        values.sort((a,b) => a-b);
        return { healthy, missing, missingError, layouts, performance: { samples: values.length, firstCheckMs, medianMs: values[250], p95Ms: values[475], maxMs: values[499] } };
        } catch (error) { return { scriptError: error.message, code: error.code, stack: error.stack }; }
      })()`);
      if (result.scriptError) throw new Error(JSON.stringify(result));
      if (result.healthy !== undefined || !result.missing) throw new Error('Incorrect integrity result through production preload');
      if (result.layouts.some(layout => layout.problem)) throw new Error(JSON.stringify(result.layouts));
      result.success = true;
      result.compilerDirectory = compiler;
      result.environment = { platform: process.platform, arch: process.arch, osRelease: os.release(),
        electron: process.versions.electron, node: process.versions.node };
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(result, null, 2) + '\n');
      console.log(JSON.stringify({ output, ...result }));
      window.destroy(); app.quit();
    } catch (error) {
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ success: false, error: error.stack }, null, 2) + '\n');
      console.error(error); app.exit(1);
    }
  });
}
