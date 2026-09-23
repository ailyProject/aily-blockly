const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

async function assertLinkedBuildCurrent(chatRoot) {
  const module = await import(pathToFileURL(path.join(chatRoot, 'scripts/portable-build-inputs.mjs')).href);
  return module.assertBuildInputsCurrent(path.resolve(chatRoot, '../..'), path.join(chatRoot, 'dist/aily-chat'));
}

/** A workspace link may still launch a portable bundle with old, copied Agent rules. */
function assertLinkedAgentResourcesCurrent(agentRoot, chatRoot) {
  const bundled = path.join(chatRoot, 'dist/aily-chat/runtime/resources/skills/aily-blockly-project');
  if (!fs.existsSync(path.join(chatRoot, 'dist/aily-chat/package.json'))) return { portable: false };
  const source = path.join(agentRoot, 'src/skills/aily-blockly-project');
  const files = directory => fs.readdirSync(directory, { recursive: true })
    .filter(file => fs.statSync(path.join(directory, file)).isFile() && !file.endsWith('.ts')).sort();
  assert.ok(fs.existsSync(bundled), 'Portable Chat is missing Blockly Agent rules; rebuild Chat with build:subapp');
  const expected = files(source), actual = files(bundled);
  const mismatches = [...new Set([...expected, ...actual])].filter(file => !expected.includes(file) || !actual.includes(file)
    || !fs.readFileSync(path.join(source, file)).equals(fs.readFileSync(path.join(bundled, file))));
  assert.deepEqual(mismatches, [], 'Portable Chat contains stale Agent rules. Rebuild Chat with build:subapp, not only aily-agent');
  return { portable: true, comparedRules: expected.length };
}

/** Opt-in reuse of the user's login, with all writes confined to the fresh test profile.
 * Never copy chat history, log token-bearing URLs, or change the user's development link.
 */
function prepareLinkedChatProfile(appData, source, agentRoot, credentialFile = 'auth/blockly.json') {
  assert.ok(path.isAbsolute(source) && path.isAbsolute(agentRoot));
  assert.ok(['auth/blockly.json', '.aily'].includes(credentialFile));
  const chatRoot = path.resolve(agentRoot, '../aily-chat');
  const resourceParity = assertLinkedAgentResourcesCurrent(agentRoot, chatRoot);
  const pkg = JSON.parse(fs.readFileSync(path.join(chatRoot, 'package.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(source, 'config.json'), 'utf8'));
  config.recentlyProjects = [];
  const files = ['config.json', credentialFile];
  const hash = file => createHash('sha256').update(fs.readFileSync(path.join(source, file))).digest('hex');
  const hashes = files.map(hash);
  fs.mkdirSync(path.join(appData, 'auth'), { recursive: true });
  fs.copyFileSync(path.join(source, credentialFile), path.join(appData, 'auth/blockly.json'));
  const install = path.join(appData, 'npm-global/app');
  const link = path.join(install, 'node_modules', pkg.ailySubapp.package);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(chatRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: 'abs-linked-chat-smoke', private: true, dependencies: {} }));
  const index = JSON.parse(fs.readFileSync(path.join(agentRoot, '../../dist/subapp-index.json'), 'utf8'));
  fs.writeFileSync(path.join(install, 'subapp-index.json'), JSON.stringify({ dev: true, 'aily-chat': index['aily-chat'] }));
  return { config, chatRoot, resourceParity, assertSourceUnchanged: () => assert.deepEqual(files.map(hash), hashes),
    assertResourcesCurrent: () => assertLinkedAgentResourcesCurrent(agentRoot, chatRoot),
    dispose: () => fs.rmSync(path.join(appData, 'auth/blockly.json'), { force: true }) };
}

async function testLinkedChat(page, root, chatRoot) {
  const expectedBuild = chatRoot ? await assertLinkedBuildCurrent(chatRoot) : undefined;
  let authentication;
  for (let attempt = 0; attempt < 120; attempt++) {
    authentication = await page.evaluate(async () => {
      const result = await window.iWindow.send({ to: 'main', data: { action: 'get-auth-state' }, timeout: 15000 });
      return { authenticated: result.authenticated === true, initializationState: result.initializationState };
    });
    if (authentication.authenticated || authentication.initializationState === 'signed_out') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(authentication.authenticated, true, `Copied login was not accepted (${authentication.initializationState})`);
  const iframe = page.locator('app-main-window nz-sider app-child-tool-host iframe');
  if (!await iframe.isVisible()) {
    await page.locator('app-main-window app-header .toolbox .btn:has(i.fa-star-christmas)').click();
  }
  await iframe.waitFor({ state: 'visible', timeout: 60000 });
  const frame = await (await iframe.elementHandle()).contentFrame();
  await frame.locator('.aily-chat-composer-input[role="textbox"]').waitFor({ state: 'visible', timeout: 60000 });
  // Use the linked process's authenticated read-only E2E interface; no test-only tool executor.
  const url = new URL(frame.url());
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const health = await (await fetch(new URL('/health', url), { signal: AbortSignal.timeout(15000) })).json();
  if (expectedBuild) {
    assert.equal(health.buildEvidence?.inputHash, expectedBuild.inputHash, 'Running backend was not built from current inputs');
    assert.equal(health.buildEvidence?.outputHash, expectedBuild.outputHash, 'Running backend is not the verified product');
  }
  const response = await fetch(new URL('/api/agent/e2e', url), { method: 'POST',
    headers: { authorization: `Bearer ${url.searchParams.get('token')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 'aily-agent-e2e', version: 4, method: 'session.list' }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const sessions = await response.json();
  assert.equal(sessions.ok, true); assert.equal(sessions.method, 'session.list');
  let loadedUi;
  if (chatRoot) {
    const ui = path.join(chatRoot, 'dist/aily-chat/ui');
    const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
    const buildTime = /name="aily-build-time" content="([^"]+)"/.exec(html)?.[1];
    assert.ok(buildTime, 'Portable UI build marker is missing');
    const loaded = await frame.evaluate(async () => {
      const script = document.querySelector('script[type="module"][src]');
      const response = await fetch(script.src, { cache: 'no-store' });
      if (!response.ok) throw new Error('Loaded module could not be verified');
      return { buildTime: document.querySelector('meta[name="aily-build-time"]')?.content,
        file: new URL(script.src).pathname, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
    });
    assert.equal(loaded.buildTime, buildTime, 'Embedded Chat loaded a different UI build');
    const entry = /<script type="module"[^>]+src="\.\/([^"]+)"/.exec(html)?.[1];
    assert.ok(entry && loaded.file.endsWith('/' + entry), 'Embedded Chat loaded a different module entry');
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const moduleHash = digest(Buffer.from(loaded.bytes));
    assert.equal(moduleHash, digest(fs.readFileSync(path.join(ui, entry))), 'Served module differs from portable output');
    loadedUi = { buildTime, entry, moduleHash };
  }
  await page.screenshot({ path: path.join(root, 'linked-chat-page.png'), fullPage: true });
  return { success: true, authentication, embedded: true, sessionCount: sessions.result.sessions.length,
    endpointOrigin: url.origin, protocolVersion: sessions.version, buildEvidence: health.buildEvidence, loadedUi, llmTurnTested: false };
}

module.exports = { prepareLinkedChatProfile, testLinkedChat, assertLinkedAgentResourcesCurrent };
