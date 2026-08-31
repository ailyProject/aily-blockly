const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

function fail(message) {
  console.error(`[guard:aily-chat-mainline] ${message}`);
  process.exitCode = 1;
}

const routes = read('src/app/app.routes.ts');
const mainWindowSource = read('src/app/main-window/main-window.component.ts');
const mainWindowTemplate = read('src/app/main-window/main-window.component.html');
const childHostTemplate = read('src/app/tools/child-tool-host/child-tool-host.component.html');
const packageJson = JSON.parse(read('package.json'));

if (!/path:\s*["']child-tool\/aily-chat["'][\s\S]*?childToolId:\s*["']aily-chat["']/u.test(routes)) {
  fail('the canonical /child-tool/aily-chat route must use the generic child-tool host');
}

if (/path:\s*["']aily-chat["']/u.test(routes)) {
  fail('the retired standalone /aily-chat route must not be restored');
}

for (const retiredSymbol of ['AilyChatComponent', 'AilyChatChildProtocolService', 'AILY_CHAT_VIEW_PROVIDERS']) {
  if (routes.includes(retiredSymbol) || mainWindowSource.includes(retiredSymbol)) {
    fail(`retired Angular symbol is reachable from the application shell: ${retiredSymbol}`);
  }
}

if (mainWindowTemplate.includes('<app-aily-chat')) {
  fail('the main window must not mount the legacy Angular Aily Chat component');
}

if (!childHostTemplate.includes('<app-subapp-activity-dock')) {
  fail('the installed Aily Chat surface must be hosted by the generic child-tool shell');
}

const retiredDirectory = 'src/app/tools/aily-chat';
if (fs.existsSync(path.join(workspaceRoot, retiredDirectory))) {
  fail(`retired Angular implementation still exists: ${retiredDirectory}`);
}

for (const dependency of ['aily-lex', 'js-tiktoken']) {
  if (packageJson.dependencies?.[dependency] || packageJson.devDependencies?.[dependency]) {
    fail(`retired dependency still exists: ${dependency}`);
  }
}

for (const retiredRuntime of [
  'electron/chat-runtime-host.js',
  'electron/chat-runtime-lex-execution-runtime.mjs',
  'electron/chat-runtime-lex-execution-runtime.bundle.mjs',
]) {
  if (fs.existsSync(path.join(workspaceRoot, retiredRuntime))) {
    fail(`retired Electron runtime still exists: ${retiredRuntime}`);
  }
}

if (!process.exitCode) {
  console.log('[guard:aily-chat-mainline] React subapp is the only Aily Chat UI entry.');
}
