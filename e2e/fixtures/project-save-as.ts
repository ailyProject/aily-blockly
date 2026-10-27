import { _electron, expect, type ElectronApplication, type Frame, type Page, type TestInfo } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http, { type ServerResponse } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { seedPlatform } from './platform-seed';
import { closeAilyElectronApp } from './electron-app';

export const ROOT = path.resolve(__dirname, '../..');
export const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
const link = (source: string, target: string) => {
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
};
export async function until<T>(probe: () => Promise<T> | T, name: string, timeout = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await probe(); if (result) return result as NonNullable<T>; await delay(100); }
  throw new Error(`等待超时：${name}`);
}

// Only model output is scripted. Chat, Agent, bash, IPC and Save As remain production implementations.
class BusyModel {
  readonly provider = 'aily-custom-eval-save-as';
  readonly model = 'save-as-controlled';
  readonly requests: Array<{ phase: string; tool?: string }> = [];
  readonly key = randomUUID();
  readonly releaseFile: string;
  held?: ServerResponse;
  private server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== `Bearer ${this.key}`) {
        response.writeHead(403).end(); return;
      }
      let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 8_000_000) throw new Error('request too large'); }
      const body = JSON.parse(raw);
      const start = body.messages.map((message: any) => message.role === 'user' && /HOLD_(?:TOOL|GENERATION)/.test(JSON.stringify(message.content))).lastIndexOf(true);
      assert.ok(body.model === this.model && start >= 0, '未识别的另存为模型请求');
      const phase = JSON.stringify(body.messages[start]?.content).includes('HOLD_TOOL') ? 'tool' : 'generation';
      const turn = body.messages.slice(start + 1);
      const calls = turn.flatMap((message: any) => message.tool_calls || []);
      const executed = turn.some((message: any) => message.role === 'tool' && calls.some((call: any) => call.id === message.tool_call_id && call.function.name !== 'tool_load'));
      let tool: { name: string; arguments: any } | undefined;
      if (phase === 'tool' && !executed) {
        const operation = { name: 'bash', arguments: { command: `node -e ${JSON.stringify(`const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(this.releaseFile)})){clearInterval(timer);console.log('SAVE_AS_TOOL_COMPLETE')}},100)`)}`, timeout: 120 } };
        tool = body.tools?.some((item: any) => item.function.name === 'bash') ? operation
          : calls.some((call: any) => call.function.name === 'tool_load')
            ? { name: 'tool_invoke', arguments: operation }
            : { name: 'tool_load', arguments: { names: ['bash'] } };
      }
      this.requests.push({ phase, ...(tool ? { tool: tool.name } : {}) });
      writeJson(path.join(this.directory, 'model-requests.json'), this.requests);
      if (this.requests.length > 30) throw new Error('模型请求未收敛');
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      this.emit(response, { role: 'assistant' });
      if (tool) {
        this.emit(response, { tool_calls: [{ index: 0, id: `eval_${randomUUID()}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] });
        this.finish(response, 'tool_calls');
      } else if (phase === 'generation') { this.held = response; this.emit(response, { content: '正在验证另存为保护。' }); }
      else { this.emit(response, { content: '工具执行完成。' }); this.finish(response); }
    } catch (error) { if (!response.headersSent) response.writeHead(400); response.end(JSON.stringify({ error: { message: String(error) } })); }
  });
  constructor(readonly directory: string) { this.releaseFile = path.join(directory, 'release-tool'); }
  private emit(response: ServerResponse, delta: unknown, finish_reason: string | null = null) {
    response.write(`data: ${JSON.stringify({ id: 'save-as-eval', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: this.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  private finish(response: ServerResponse, reason = 'stop') { if (!response.destroyed) { this.emit(response, {}, reason); response.end('data: [DONE]\n\n'); } }
  release() { if (this.held) this.finish(this.held); this.held = undefined; fs.writeFileSync(this.releaseFile, 'release'); }
  async environment() {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as { port: number };
    const home = path.join(this.directory, 'agent');
    writeJson(path.join(home, 'models.json'), { providers: { [this.provider]: {
      name: 'Eval 另存为受控模型', api: 'openai-completions', apiKey: this.key,
      baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: this.model, contextWindow: 128000, maxTokens: 4096 }],
    } } });
    return { PI_CODING_AGENT_DIR: home, AILY_AGENT_HOME: home };
  }
  async close() { this.release(); this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}

export class SaveAsApp {
  app!: ElectronApplication;
  page!: Page;
  readonly source: string;
  readonly model: BusyModel;
  private catalog?: http.Server;
  private log?: fs.WriteStream;
  private frame?: Frame;
  private sessionId?: string;
  private workspaceBefore?: string;
  readonly evidence: Record<string, unknown> = { simulatedModel: false, realChatAndAgent: false, realNativeIpc: true };
  constructor(readonly mode: 'blockly' | 'coder', readonly info: TestInfo) {
    this.source = info.outputPath('workspace', '原项目 A');
    this.model = new BusyModel(info.outputPath('workspace'));
  }
  async start(withChat = false) {
    const seed = process.env['AILY_E2E_PLATFORM_SEED'];
    const coder = process.env['AILY_E2E_CODER_ROOT'];
    const chat = process.env['AILY_E2E_CHAT_ROOT'];
    assert.ok(seed, '必须提供 AILY_E2E_PLATFORM_SEED；不下载或修改用户 SDK');
    assert.ok(this.mode !== 'coder' || coder, '必须提供已构建的 AILY_E2E_CODER_ROOT');
    assert.ok(!withChat || chat, '必须提供已构建的便携包 AILY_E2E_CHAT_ROOT');
    const work = path.dirname(this.source), stage = path.join(work, 'app'), appdata = path.join(work, 'appdata');
    fs.mkdirSync(stage, { recursive: true });
    fs.cpSync(path.join(ROOT, 'electron'), path.join(stage, 'electron'), { recursive: true,
      filter: source => !path.relative(path.join(ROOT, 'electron'), source).split(path.sep).some(part => ['node_modules', 'tests', 'test'].includes(part)) });
    for (const name of ['node_modules', 'electron/node_modules', 'child', 'renderer']) if (fs.existsSync(path.join(ROOT, name))) link(path.join(ROOT, name), path.join(stage, name));
    fs.copyFileSync(path.join(ROOT, 'e2e/electron/fixtures/subapp-product-bootstrap.cjs'), path.join(stage, 'electron/bootstrap.cjs'));
    writeJson(path.join(stage, 'package.json'), { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')), main: 'electron/bootstrap.cjs' });
    const appRoot = path.join(appdata, 'npm-global/app'), index: Record<string, any> = { dev: true }, dependencies: Record<string, string> = {};
    for (const [id, source] of [['aily-coder-editor', this.mode === 'coder' ? coder : undefined], ['aily-chat', withChat ? chat : undefined]]) {
      if (!source) continue;
      const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
      link(source, path.join(appRoot, 'node_modules', manifest.name)); dependencies[manifest.name] = manifest.version;
      index[id!] = { ...manifest.ailySubapp, namespace: id!.replaceAll('-', '_').toUpperCase(), titleKey: id, id, package: manifest.name, version: manifest.version, app: { ...manifest.ailySubapp.app, autoInstall: false } };
    }
    writeJson(path.join(appRoot, 'package.json'), { name: 'save-as-e2e', private: true, dependencies });
    writeJson(path.join(appRoot, 'subapp-index.json'), index);
    this.catalog = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json'); response.setHeader('access-control-allow-origin', request.headers.origin || '*'); response.setHeader('access-control-allow-headers', '*');
      response.end(JSON.stringify(request.url === '/subapp-index.json' ? index : { status: 200, data: { id: 'save-as-e2e', nickname: 'Eval', groups: [] } }));
    });
    await new Promise<void>(resolve => this.catalog!.listen(0, '127.0.0.1', resolve));
    const catalogUrl = `http://127.0.0.1:${(this.catalog.address() as { port: number }).port}`;
    const configPath = path.join(stage, 'electron/config/config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const region of Object.values(config.regions || {}) as any[]) region.api_server = catalogUrl;
    config.onboardingCompleted = true; config.blocklyOnboardingCompleted = true;
    config.project_path = path.join(work, 'projects'); writeJson(configPath, config);
    writeJson(path.join(appdata, 'auth', `${this.mode}.json`), { access_token: 'isolated-e2e' });
    const board = path.join(seed, 'node_modules/@aily-project/board-arduino_uno');
    fs.cpSync(path.join(board, this.mode === 'blockly' ? 'template' : 'template_arduino'), this.source, { recursive: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(this.source, 'package.json'), 'utf8'));
    pkg.name = 'source'; pkg.nickname = '原项目 A'; pkg.type = this.mode; pkg.cloudId = 'source-cloud-identity';
    writeJson(path.join(this.source, 'package.json'), pkg);
    for (const name of Object.keys(pkg.dependencies)) {
      const dependencySeed = fs.existsSync(path.join(seed, 'node_modules', name)) ? seed : process.env['AILY_E2E_PROJECT_DEPENDENCY_SEED'];
      assert.ok(dependencySeed, `缺少依赖种子 ${name}`);
      for (const target of [this.source, appdata]) fs.cpSync(path.join(dependencySeed, 'node_modules', name), path.join(target, 'node_modules', name), { recursive: true, dereference: true });
    }
    await seedPlatform(this.source, appdata, seed);
    for (const name of ['npm-global/bin', 'npm-global/lib']) if (fs.existsSync(path.join(seed, name))) fs.cpSync(path.join(seed, name), path.join(appdata, name), { recursive: true });
    fs.mkdirSync(path.join(this.source, 'assets'), { recursive: true }); fs.writeFileSync(path.join(this.source, 'assets/中文 资源.txt'), '原项目资源\n');
    if (this.mode === 'coder') {
      fs.mkdirSync(path.join(this.source, 'sketch/src'), { recursive: true });
      fs.writeFileSync(path.join(this.source, 'sketch/src/main.cpp'), '// SAVED_SOURCE\nvoid setup() {}\nvoid loop() {}\n');
      fs.writeFileSync(path.join(this.source, 'sketch/src/中文.h'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('// 原始\r\n', 'utf16le')]));
    }
    const home = path.join(work, 'home'); fs.mkdirSync(home, { recursive: true });
    const modelEnvironment = withChat ? await this.model.environment() : {};
    const { ELECTRON_RUN_AS_NODE, ...environment } = process.env;
    this.log = fs.createWriteStream(this.info.outputPath('electron.log'));
    const record = (data: unknown) => { if (!this.log?.writableEnded) this.log?.write(String(data).replace(/([?&]token=)[^&\s"']+/g, '$1[redacted]')); };
    this.app = await _electron.launch({ cwd: stage, args: [stage, `--user-data-dir=${path.join(work, 'profile')}`], timeout: 60_000,
      env: { ...environment, ...modelEnvironment, HOME: home, AILY_E2E: '1', AILY_APPDATA_PATH: appdata,
        AILY_PRODUCT_ACCEPTANCE_ROOT: work, AILY_BUILD_PRODUCT: this.mode, AILY_SUBAPP_INSTALL_ROOT: appRoot, AILY_SUBAPP_INDEX_URL: `${catalogUrl}/subapp-index.json` } });
    await this.app.context().tracing.start({ screenshots: true, snapshots: true });
    this.app.process().stdout?.on('data', record); this.app.process().stderr?.on('data', record);
    this.page = await until(async () => { for (const page of this.app.windows()) if (await page.locator('app-header').count().catch(() => 0)) return page; }, '主窗口');
    this.page.setDefaultTimeout(30_000);
    this.page.on('console', event => record(`[renderer:${event.type()}] ${event.text()}\n`));
    this.page.on('pageerror', error => record(`[renderer-error] ${error.stack}\n`));
    await this.page.addLocatorHandler(this.page.getByText('跳过', { exact: true }), async locator => {
      const menuWasOpen = await this.page.locator('app-header app-menu:not(.ports) .menu-item').first().isVisible();
      await locator.click();
      await this.page.locator('.onboarding-overlay').waitFor({ state: 'hidden' });
      // Skipping the editor tour closes an already open product menu.
      if (menuWasOpen) await this.page.locator('app-main-window app-header .menu').click();
    });
    await this.app.evaluate(({ dialog }) => {
      const state = (globalThis as any).__saveAsDialog = { queue: [], calls: [], opens: [], openQueue: [], pending: null };
      dialog.showOpenDialog = async () => ({ canceled: !state.openQueue.length, filePaths: state.openQueue.splice(0, 1) });
      dialog.showSaveDialog = async (...args: any[]) => {
        state.calls.push(args.at(-1));
        const next = state.queue.shift();
        if (next?.hold) return new Promise<any>(resolve => { state.pending = resolve; });
        return { canceled: !next?.path, filePath: next?.path };
      };
    });
    const skip = this.page.getByText('跳过', { exact: true });
    if (await skip.isVisible()) await skip.click();
    await this.page.locator('.onboarding-overlay').waitFor({ state: 'hidden' });
    await this.open(this.source);
    await this.save(); // Finish normal template migration before freezing source bytes.
    this.evidence['builds'] = Object.fromEntries([
      ['hostRenderer', path.join(ROOT, 'renderer/index.html')],
      ['coderRuntime', coder && path.join(coder, 'runtime/index.js')],
      ['chatReceipt', withChat && chat && path.join(chat, 'runtime/build-evidence.json')],
    ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && fs.existsSync(entry[1]))
      .map(([name, file]) => [name, { file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }]));
    this.evidence['mode'] = this.mode;
    this.evidence['renderer'] = 'production-file';
    this.evidence['seed'] = 'read-only installed board, libraries and toolchain';
  }
  async menu(icon: string) {
    // Do not mistake a previous operation's still-visible toast for this operation's result.
    await expect(this.page.locator('.ant-message-notice')).toHaveCount(0);
    await this.page.locator('app-main-window app-header .menu').click();
    await this.page.locator(`app-header app-menu:not(.ports) .menu-item:has(i.${icon})`).click();
  }
  active() { return new URLSearchParams(new URL(this.page.url()).hash.split('?')[1]).get('path'); }
  async open(directory: string) {
    const before = this.mode === 'blockly' ? await this.page.evaluate(() => (globalThis as any).blocklyWorkspace?.id as string | undefined) : undefined;
    await this.app.evaluate((_, directory) => { (globalThis as any).__saveAsDialog.openQueue.push(directory); }, directory);
    await this.menu('fa-folder-open');
    await expect.poll(() => this.active(), { timeout: 120_000 }).toBe(directory);
    if (this.mode === 'blockly') {
      await this.page.waitForFunction(before => { const workspace = (globalThis as any).blocklyWorkspace; return workspace && workspace.id !== before && workspace.getAllBlocks(false).length > 0; }, before, { timeout: 120_000 });
      await this.page.locator('blockly-main .blocklySvg').first().waitFor({ timeout: 120_000 });
      await this.page.locator('app-footer .footer-status-area .state:has(i.fa-circle-check)').waitFor({ timeout: 120_000 });
    } else await this.coder();
  }
  async coder(): Promise<Frame> {
    return until(async () => {
      const handle = await this.page.locator('app-code-editor-frame[aria-hidden="false"] iframe.is-ready').elementHandle();
      const frame = await handle?.contentFrame();
      if (frame && await frame.locator('.monaco-workbench').count()) return frame;
      return undefined;
    }, '当前 Coder 工作台', 120_000);
  }
  async save() {
    await this.menu('fa-file-circle-check');
    await this.page.locator('.ant-message-success').filter({ hasText: /项目.*保存|project.*saved/i }).last().waitFor({ timeout: 60_000 });
    await expect(this.page.locator('app-header .project-box')).toHaveAttribute('data-unsaved', 'false');
  }
  async choose(target?: string, hold = false) {
    const before = await this.dialogCount();
    if (this.mode === 'blockly') this.workspaceBefore = await this.page.evaluate(() => (globalThis as any).blocklyWorkspace?.id);
    await this.app.evaluate((_, value) => { (globalThis as any).__saveAsDialog.queue.push(value); }, { path: target, hold });
    await this.menu('fa-copy');
    await expect.poll(() => this.dialogCount()).toBe(before + 1);
  }
  async dialogCount() { return this.app.evaluate(() => (globalThis as any).__saveAsDialog.calls.length); }
  async resolveDialog(target: string) {
    await this.app.evaluate((_, target) => { const state = (globalThis as any).__saveAsDialog; if (!state.pending) throw new Error('没有等待中的原生对话框'); state.pending({ canceled: false, filePath: target }); state.pending = null; }, target);
  }
  async copied(target: string) {
    await until(async () => {
      const error = await this.page.locator('.ant-message-error').allTextContents();
      if (error.length) throw new Error(error.join('；'));
      return this.active() === target;
    }, `激活另存为副本 ${target}`, 120_000);
    await expect(this.page.locator('app-header .project-title')).toHaveText(path.basename(target));
    if (this.mode === 'blockly') {
      await this.page.waitForFunction(before => { const workspace = (globalThis as any).blocklyWorkspace; return workspace && workspace.id !== before && workspace.getAllBlocks(false).length > 0; }, this.workspaceBefore, { timeout: 120_000 });
      await this.page.locator('.blockly-spin').waitFor({ state: 'hidden', timeout: 120_000 });
      await this.page.locator('app-footer .footer-status-area .state:has(i.fa-circle-check)').waitFor({ timeout: 120_000 });
    } else await this.coder();
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    expect(manifest.cloudId).toBeUndefined(); expect(manifest.nickname).toBe(path.basename(target));
    expect(fs.readFileSync(path.join(target, 'assets/中文 资源.txt'), 'utf8')).toBe('原项目资源\n');
    await expect(this.page.locator('app-header .project-box')).toHaveAttribute('data-unsaved', 'false');
  }
  async edit(marker: number, file = 'main.cpp') {
    if (this.mode === 'coder') {
      const frame = await this.coder(); const item = frame.getByText(file, { exact: true }).first(); await item.waitFor({ timeout: 90_000 }); await item.dblclick();
      const view = frame.locator('.monaco-editor .view-lines').first(); await view.waitFor(); await view.click();
      await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
      await this.page.keyboard.insertText(`// UNSAVED_${marker}\nvoid setup() {}\nvoid loop() {}\n`);
    } else {
      const ids = await this.page.evaluate(() => (globalThis as any).blocklyWorkspace.getAllBlocks(false).map((block: any) => block.id));
      await this.page.locator('[data-toolbox-sort-key="@aily-project/lib-core-time"] .toolbox-item').click();
      const id = await this.page.evaluate(() => (globalThis as any).blocklyWorkspace.getFlyout().getWorkspace().getTopBlocks(false).find((block: any) => block.getDescendants(false).some((child: any) => child.inputList.some((input: any) => input.fieldRow.some((field: any) => field.name && typeof field.getValue() === 'number')))).id);
      const sourceBlock = this.page.locator(`.blocklyFlyout:visible g[data-id="${id}"]`).first();
      await sourceBlock.hover({ position: { x: 50, y: 20 } }); // Wait for the opening flyout's transform to settle.
      const geometry = await this.page.evaluate(id => {
        const workspace = (globalThis as any).blocklyWorkspace;
        const block = workspace.getFlyout().getWorkspace().getBlockById(id);
        const rect = block.getSvgRoot().getBoundingClientRect();
        const canvas = workspace.getParentSvg().getBoundingClientRect();
        const point = document.elementFromPoint(rect.x + 50, rect.y + rect.height / 2);
        return { source: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          canvas: { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height },
          readOnly: workspace.options.readOnly, movable: block.isMovable(), enabled: block.isEnabled(), hit: point?.outerHTML.slice(0, 400), blockId: id };
      }, id);
      writeJson(this.info.outputPath(`drag-${marker}.json`), geometry);
      const { source, canvas } = geometry;
      await this.page.mouse.move(source.x + 50, source.y + source.height / 2); await this.page.mouse.down(); await delay(150);
      await this.page.mouse.move(canvas.x + canvas.width * 0.6, canvas.y + canvas.height * 0.6, { steps: 24 }); await delay(150); await this.page.mouse.up();
      const field = await until(() => this.page.evaluate(ids => {
        const block = (globalThis as any).blocklyWorkspace.getTopBlocks(false).find((block: any) => !ids.includes(block.id));
        for (const child of block?.getDescendants(false) || []) for (const input of child.inputList) for (const field of input.fieldRow) {
          if (!field.name || typeof field.getValue() !== 'number') continue; const box = field.getSvgRoot()?.getBoundingClientRect();
          if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        } return null;
      }, ids), '拖入新积木数字字段');
      await this.page.mouse.click(field.x, field.y); const input = this.page.locator('input.blocklyHtmlInput'); await input.fill(String(marker)); await input.press('Enter');
    }
    await expect(this.page.locator('app-header .project-box')).toHaveAttribute('data-unsaved', 'true');
  }
  snapshot(directory = this.source) {
    const files = this.mode === 'blockly' ? ['package.json', 'project.abi', 'project.abs', 'project.abs.map.json'] : ['package.json', 'sketch/src/main.cpp', 'sketch/src/中文.h'];
    return Object.fromEntries([...files, 'assets/中文 资源.txt'].filter(name => fs.existsSync(path.join(directory, name))).map(name => [name, fs.readFileSync(path.join(directory, name)).toString('base64')]));
  }
  assertSnapshot(expected: ReturnType<SaveAsApp['snapshot']>, directory = this.source) { expect(this.snapshot(directory)).toEqual(expected); }
  assertMarker(target: string, marker: number) {
    const file = this.mode === 'blockly' ? 'project.abi' : 'sketch/src/main.cpp';
    expect(fs.readFileSync(path.join(target, file), 'utf8')).toContain(String(marker));
    if (this.mode === 'blockly') {
      expect(fs.readFileSync(path.join(target, 'project.abs'), 'utf8')).toContain(String(marker));
      expect(JSON.parse(fs.readFileSync(path.join(target, 'project.abs.map.json'), 'utf8')).scope.projectKey).toBe(target);
    }
  }
  async warning(pattern: RegExp) { await this.page.locator('.ant-message-notice-content').filter({ hasText: pattern }).last().waitFor(); }
  async chat() {
    await this.page.locator('app-header .toolbox .btn:has(i.fa-star-christmas)').click();
    this.frame = await until(async () => { for (const frame of this.page.frames()) if (await frame.locator('.aily-chat-wrapper').count()) return frame; }, '真实 Chat iframe', 120_000);
    await this.frame.locator('.aily-chat-composer-input[role="textbox"]').waitFor({ timeout: 60_000 });
    const url = new URL(this.frame.url());
    const inspect = async (method: string, values = {}) => {
      const response = await fetch(`${url.origin}/api/agent/e2e`, { method: 'POST', headers: { authorization: `Bearer ${url.searchParams.get('token')}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'aily-agent-e2e', version: 4, method, ...values }) });
      const result = await response.json(); assert.ok(response.ok && result.ok, JSON.stringify(result.error)); return result.result;
    };
    await this.frame.locator('button[title="新建会话"],button[title="New chat"]').click();
    this.sessionId = await until(async () => {
      const { sessions } = await inspect('session.list'); const match = sessions.filter((session: any) => path.resolve(session.cwd) === this.source);
      return match.length === 1 && match[0].sessionId;
    }, '空白 Chat 会话');
    await this.frame.locator('.permission-mode-indicator').click();
    await this.frame.getByText('完全访问权限', { exact: true }).click();
    await this.frame.locator('.full-access-permission-dialog .confirm-btn').click();
    await expect(this.frame.locator('.permission-mode-indicator')).toHaveText(/完全|Full/i);
    await this.frame.locator('.composer-model-chip').click();
    await this.frame.locator('.popup-menu-model input').fill(this.model.model);
    await this.frame.locator('.popup-menu-model .popup-menu-entry button').filter({ hasText: this.model.model }).first().click();
    await expect(this.frame.locator('.composer-model-chip')).toContainText(this.model.model);
    const snapshot = (await inspect('session.read', { sessionId: this.sessionId })).session;
    expect(snapshot.permissionMode).toBe('full');
    await expect(this.frame.locator('.permission-mode-indicator')).toContainText(/完全|Full/i); expect(snapshot.model).toMatchObject({ provider: this.model.provider, id: this.model.model });
    expect(snapshot.entries.some((entry: any) => entry.message?.role === 'user')).toBe(false);
    Object.assign(this.evidence, { simulatedModel: true, realChatAndAgent: true, permissionMode: snapshot.permissionMode, model: snapshot.model, sessionId: this.sessionId });
    return { inspect, snapshot: async () => (await inspect('session.read', { sessionId: this.sessionId })).session,
      send: async (phase: string) => { const composer = this.frame!.locator('.aily-chat-composer-input[role="textbox"]'); await composer.fill(phase); await composer.press('Enter'); },
      stop: async () => { await this.frame!.locator('button:has(i.fa-stop)').click(); } };
  }
  async close() {
    this.model.release();
    if (this.page && !this.page.isClosed()) await this.page.screenshot({ path: this.info.outputPath('final.png') }).catch(() => {});
    if (this.app) {
      await this.app.context().tracing.stop({ path: this.info.outputPath('trace.zip') }).catch(() => {});
      await this.info.attach('Electron trace', { path: this.info.outputPath('trace.zip'), contentType: 'application/zip' }).catch(() => {});
      await closeAilyElectronApp(this.app);
    }
    if (this.catalog) { this.catalog.closeAllConnections(); await new Promise<void>(resolve => this.catalog!.close(() => resolve())); }
    await this.model.close(); this.log?.end();
    writeJson(this.info.outputPath('save-as-evidence.json'), { ...this.evidence, modelRequests: this.model.requests, verdictSource: 'results.json (Playwright)' });
    await this.info.attach('另存为证据', { path: this.info.outputPath('save-as-evidence.json'), contentType: 'application/json' });
  }
}
