'use strict';
// Real Electron windows with a disposable profile, no account, UART or feedback submission.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'e2e/.results/settings-persistence');
const build = path.resolve(process.env.AILY_SERIAL_ISSUES_BUILD || path.join(root, 'e2e/.results/serial-issues-build/browser'));
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'profile-'));
const bootstrap = path.join(profile, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
const {app}=require('electron'); const fs=require('node:fs'); const path=require('node:path');
const root=${JSON.stringify(root)}, profile=__dirname;
app.setPath('userData',path.join(profile,'chromium')); app.setPath('sessionData',path.join(profile,'session'));
app.setPath('documents',profile); app.setAsDefaultProtocolClient=app.removeAsDefaultProtocolClient=()=>false;
app.setUserTasks=()=>false; app.setAppUserModelId=()=>{};
process.env.AILY_E2E='1'; process.env.AILY_APPDATA_PATH=path.join(profile,'data');
process.env.AILY_APP_VERSION=require(path.join(root,'package.json')).version;
process.env.USERPROFILE=profile; process.env.PI_CODING_AGENT_DIR=path.join(profile,'agent');
fs.mkdirSync(process.env.AILY_APPDATA_PATH,{recursive:true});
const config=JSON.parse(fs.readFileSync(path.join(root,'electron/config/config.json')));
config.onboardingCompleted=true; config.project_path=path.join(profile,'projects'); config.metricsEnabled=false;
// Legacy profiles without this preference must also start with autosave off.
delete config.blockly.autoSave;
fs.writeFileSync(path.join(process.env.AILY_APPDATA_PATH,'config.json'),JSON.stringify(config));
// Override only the fixture's asset location; production IPC/window code is unchanged.
const renderer=require(path.join(root,'electron/packaged-renderer-server'));
const create=renderer.createPackagedRendererServer;
renderer.createPackagedRendererServer=(options)=>{const server=create(options);return {...server,start:(options)=>server.start({...options,rootDirectory:${JSON.stringify(build)}})};};
require(path.join(root,'electron/main.js'));
`);

async function main() {
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  let app;
  const errors = [];
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [bootstrap], cwd: root, env, timeout: 60000 });
    await app.context().route('**/*', route => /^https?:/.test(route.request().url()) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(route.request().url()) ? route.abort() : route.continue());
    let mainPage;
    await expect.poll(async () => {
      for (const page of app.windows()) if (await page.locator('app-main-window app-header').count().catch(() => 0)) { mainPage = page; return true; }
      return false;
    }, { timeout: 60000 }).toBe(true);
    const openSettings = async () => {
      await mainPage.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).uiService.openWindow({type:'window',path:'settings',windowClass:'builtin',width:700,height:550}));
      let settings;
      await expect.poll(async () => {
        for (const page of app.windows()) if (await page.locator('app-settings').count().catch(() => 0)) { settings = page; return true; }
        return false;
      }, { timeout: 30000 }).toBe(true);
      return settings;
    };
    let settings = await openSettings();
    settings.on('pageerror', error => errors.push(error.message));
    await expect(settings.locator('#blockly-autosave')).toBeAttached();
    await expect(settings.locator('#blockly-autosave')).not.toHaveClass(/ant-switch-checked/);
    await settings.getByText('Zelos', {exact:true}).click();
    await expect(settings.locator('.blockly-save-status')).toContainText(/已自动保存|Saved automatically/);
    const configPath = path.join(profile, 'data/config.json');
    const saved = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved().blockly.renderer, 'zelos');
    await settings.locator('#blockly-autosave').click();
    await expect.poll(() => saved().blockly.autoSave).toBe(true);
    await expect(settings.locator('.blockly-save-status')).toContainText(/已自动保存|Saved automatically/);
    await settings.screenshot({path:path.join(output,'settings-saved.png')});
    // Destroy only this isolated test's settings window so reopening reads disk.
    const native = await app.browserWindow(settings); await native.evaluate(win => win.destroy());
    await expect.poll(() => settings.isClosed()).toBe(true);
    settings = await openSettings();
    await expect.poll(() => settings.evaluate(() => window.ng.getComponent(document.querySelector('app-settings')).configData.blockly.renderer)).toBe('zelos');
    await expect(settings.locator('#blockly-autosave')).toHaveClass(/ant-switch-checked/);
    await settings.locator('#blockly-autosave').click();
    await expect.poll(() => saved().blockly.autoSave).toBe(false);
    assert.deepEqual(errors, []);
    const result = {passed:true,checks:['auto-save setting is visible','select Zelos persists to actual config file','new settings renderer reads Zelos after window destruction','project auto-save toggle persists both states']};
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  } finally { if (app) await app.evaluate(({app}) => app.quit()).catch(() => undefined); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
