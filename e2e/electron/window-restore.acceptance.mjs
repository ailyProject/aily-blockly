import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(path.join(root, 'package.json'));
const { _electron, expect } = require('@playwright/test');
const output = fs.mkdtempSync(path.join(root, 'e2e/.artifacts/window-restore-'));
const stage = path.join(output, 'app'), appdata = path.join(output, 'appdata');
const report = { platform: process.platform, output, checks: [], pageErrors: [] };
const write = (name, value) => { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, JSON.stringify(value, null, 2)); };
const link = (source, destination) => { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir'); };
let application;
const submissions = [];
const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.end(); return; }
    if (req.url === '/subapp-index.json') { res.end(JSON.stringify({})); return; }
    if (req.url === '/api/v1/feedback/submit') {
        let text = ''; for await (const chunk of req) text += chunk;
        submissions.push(JSON.parse(text));
        res.end(JSON.stringify({ status: 201 })); return;
    }
    res.end(JSON.stringify({ status: 200, data: { id: 'window-regression', nickname: 'Regression', groups: [], quota_info: [] } }));
});

try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    fs.cpSync(path.join(root, 'electron'), path.join(stage, 'electron'), { recursive: true,
        filter: source => !path.relative(path.join(root, 'electron'), source).split(path.sep).includes('node_modules') });
    link(path.join(root, 'node_modules'), path.join(stage, 'node_modules'));
    link(path.join(root, 'electron/node_modules'), path.join(stage, 'electron/node_modules'));
    link(path.join(root, 'child'), path.join(stage, 'child'));
    link(path.join(root, 'dist/aily-blockly/browser'), path.join(stage, 'renderer'));
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    write(path.join(stage, 'package.json'), { ...metadata, main: 'electron/window-regression-bootstrap.cjs' });
    fs.writeFileSync(path.join(stage, 'electron/window-regression-bootstrap.cjs'),
        "const {app}=require('electron');app.setAsDefaultProtocolClient=()=>false;app.removeAsDefaultProtocolClient=()=>false;require('./main.js');");
    const config = JSON.parse(fs.readFileSync(path.join(stage, 'electron/config/config.json')));
    for (const region of Object.values(config.regions)) region.api_server = origin;
    config.project_path = path.join(output, 'projects');
    write(path.join(stage, 'electron/config/config.json'), config);
    write(path.join(appdata, 'auth/blockly.json'), { access_token: 'isolated-fixture-token' });
    write(path.join(appdata, 'window-state.json'), { x: 3000, y: 50, width: 5000, height: 4000, isMaximized: false, isFullScreen: false });
    // A local runnable package fixture checks real installation discovery without starting Chat.
    const install = path.join(appdata, 'npm-global/app/node_modules/@aily-project/subapp-aily-chat');
    write(path.join(install, 'package.json'), { name: '@aily-project/subapp-aily-chat', version: '0.1.33', main: 'server.cjs',
        aily: { uiIndex: 'ui/index.html' }, ailySubapp: { id: 'aily-chat' } });
    fs.writeFileSync(path.join(install, 'server.cjs'), 'module.exports = {};');
    fs.mkdirSync(path.join(install, 'ui')); fs.writeFileSync(path.join(install, 'ui/index.html'), '<p>Installation fixture</p>');
    const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, ...baseEnv } = process.env;
    const launch = async () => {
        application = await _electron.launch({ executablePath: require('electron'), cwd: stage,
            args: [stage, `--user-data-dir=${path.join(output, 'profile')}`], timeout: 60000,
            env: { ...baseEnv, HOME: path.join(output, 'home'), AILY_E2E: '1', AILY_APPDATA_PATH: appdata,
                AILY_BUILD_PRODUCT: 'blockly', AILY_SUBAPP_INSTALL_ROOT: path.join(appdata, 'npm-global/app'),
                AILY_SUBAPP_INDEX_URL: `${origin}/subapp-index.json` } });
        const log = fs.createWriteStream(path.join(output, `electron-${report.checks.length}.log`));
        application.process().stdout?.on('data', data => log.write(data));
        application.process().stderr?.on('data', data => log.write(data));
        let main;
        for (let attempt = 0; attempt < 150 && !main; attempt++) {
            for (const page of application.windows()) {
                if (await page.locator('app-main-window').count().catch(() => 0)) { main = page; break; }
            }
            if (!main) await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!main) {
            const pages = [];
            for (const page of application.windows()) {
                pages.push({ url: page.url(), body: await page.locator('body').innerText().catch(() => '') });
                await page.screenshot({ path: path.join(output, `startup-${pages.length}.png`) }).catch(() => {});
            }
            write(path.join(output, 'startup.json'), pages);
            throw new Error('Main renderer not attached; see startup.json');
        }
        main.on('pageerror', error => report.pageErrors.push(error.message));
        await main.addLocatorHandler(main.getByText('跳过', { exact: true }), locator => locator.click());
        return main;
    };
    let main = await launch();
    const state = () => main.evaluate(() => window.electronAPI.iWindow.getState());
    const toggle = () => main.evaluate(() => window.electronAPI.iWindow.toggleMaximize());
    const normal = await state();
    assert.equal(normal.canRestore, false); assert.ok(normal.bounds.width < 5000);
    report.checks.push('oversized-persisted-normal-bounds-repaired');
    for (let i = 0; i < 3; i++) {
        assert.equal((await toggle()).state.canRestore, true);
        const restored = await toggle(); assert.equal(restored.success, true); assert.equal(restored.state.canRestore, false);
    }
    report.checks.push('three-native-maximize-restore-cycles');
    await application.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url).setFullScreen(true), main.url());
    await expect.poll(async () => (await state()).fullScreen, { timeout: 10000 }).toBe(true);
    await expect.poll(async () => (await state()).canRestore).toBe(true);
    const restored = await toggle(); assert.equal(restored.success, true); assert.equal(restored.state.fullScreen, false);
    report.checks.push('native-fullscreen-restored-through-production-ipc');
    const diagnostics = await main.evaluate(() => window.electronAPI.iWindow.diagnostics());
    assert.ok(diagnostics.displays[0].scaleFactor > 0);
    assert.ok(diagnostics.window.normalBounds.width > 0);
    write(path.join(output, 'window-diagnostics.json'), diagnostics);
    report.checks.push('production-window-display-diagnostics');

    async function feedback(title) {
        await main.locator('app-header .menu').click();
        await main.locator('app-menu .menu-item').filter({ hasText: /反馈|Feedback/ }).click();
        const modal = main.locator('app-feedback-dialog'); await modal.waitFor();
        await modal.locator('input[nz-input]').first().fill(title);
        await modal.locator('textarea').fill('Window restore regression with local-only captured feedback.');
        const count = submissions.length;
        await modal.getByRole('button', { name: /提交|Submit/ }).click();
        await expect.poll(() => submissions.length).toBe(count + 1);
        await expect(modal).toHaveCount(0);
        return submissions.at(-1).content;
    }
    const installed = await feedback('Window installed Chat regression');
    assert.match(installed, /\| Installed \| true \|/);
    assert.match(installed, /\| Selected Version \| 0\.1\.33 \|/);
    assert.match(installed, /"scaleFactor":/);
    assert.match(installed, /"normalBounds":/);
    report.checks.push('real-feedback-ui-includes-installed-chat-and-displays');
    fs.renameSync(install, `${install}.disabled`);
    const missing = await feedback('Window missing Chat regression');
    assert.match(missing, /\| Installed \| false \|/);
    assert.match(missing, /\| Selected Version \| null \|/);
    report.checks.push('real-feedback-ui-reports-uninstalled-chat');
    write(path.join(output, 'captured-feedback.json'), submissions);
    await main.screenshot({ path: path.join(output, 'normal-window.png') });
    await toggle();
    await application.close(); application = null;
    const persisted = JSON.parse(fs.readFileSync(path.join(appdata, 'window-state.json')));
    assert.equal(persisted.isMaximized, true);
    assert.ok(persisted.width < 5000);
    main = await launch();
    await expect.poll(async () => (await state()).canRestore).toBe(true);
    assert.equal((await toggle()).state.canRestore, false);
    report.checks.push('restart-retains-normal-bounds-and-restores-from-maximized');
    assert.deepEqual(report.pageErrors, []);
    report.success = true;
} finally {
    await application?.close().catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    write(path.join(output, 'report.json'), report);
    console.log(JSON.stringify(report, null, 2));
}
