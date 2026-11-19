'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const component = path.join(root, 'src/app/components/subapp-activity-dock/subapp-activity-dock.component');
const localeRoot = path.join(root, 'public/i18n');
const languages = fs.readdirSync(localeRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
const dictionaries = Object.fromEntries(languages.map(lang => [lang, JSON.parse(fs.readFileSync(path.join(localeRoot, lang, lang + '.json'), 'utf8')).SUBAPP_DOCK]));

function dockPrototype() {
  const compiled = ts.transpileModule(fs.readFileSync(component + '.ts', 'utf8'), {
    fileName: component + '.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics.length, 0);
  const module = { exports: {} };
  const decorator = () => () => {};
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports,
    require(name) {
      if (name === '@angular/core') return { Component: decorator, HostBinding: decorator, Input: decorator, Output: decorator, ChangeDetectionStrategy: { OnPush: 0 } };
      if (name === '../../configs/tool.config') return { getChildToolConfig: () => null };
      return {};
    },
  }, { filename: component + '.ts' });
  return module.exports.SubappActivityDockComponent.prototype;
}

async function templateNodes(file = component + '.html') {
  const { parseTemplate } = await import('@angular/compiler');
  const parsed = parseTemplate(fs.readFileSync(file, 'utf8'), file);
  assert.equal(parsed.errors, null);
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    for (const key of ['children', 'branches', 'inputs']) for (const child of node[key] || []) visit(child);
  }
  parsed.nodes.forEach(visit);
  return nodes;
}

test('every host locale covers the Dock namespace and preserves count interpolation', () => {
  const required = ['LABEL', 'TITLE', 'OPEN_FULL', 'OPEN_EMBEDDED', 'OPEN_WINDOW', 'COLLAPSE', 'CALL_COUNT', 'RUNTIME_READY', 'RUNTIME_STARTING', 'RUNTIME_ERROR', 'RUNTIME_STOPPED', 'RUNTIME_UNKNOWN', 'INVOCATION_RUNNING', 'INVOCATION_SUCCEEDED', 'INVOCATION_FAILED', 'INVOCATION_CANCELLED', 'INVOCATION_IDLE', 'WAITING_RUNTIME', 'LOADING_SURFACE', 'RUNTIME_NOT_RETAINED', 'SURFACE_ERROR', 'SURFACE_TITLE'].sort();
  for (const [lang, dictionary] of Object.entries(dictionaries)) {
    assert.ok(dictionary, lang);
    assert.deepEqual(Object.keys(dictionary).sort(), required, lang);
    for (const [key, text] of Object.entries(dictionary)) {
      assert.equal(typeof text, 'string', lang + '.' + key);
      assert.ok(text.trim().length > 0 && !text.includes('SUBAPP_DOCK.'), lang + '.' + key);
      const placeholders = key === 'CALL_COUNT' ? ['{{count}}'] : key === 'SURFACE_TITLE' ? ['{{toolId}}', '{{surface}}'] : [];
      assert.deepEqual(text.match(/\{\{[^}]+\}\}/g) || [], placeholders, lang + '.' + key);
    }
  }
});

test('all runtime and invocation states resolve to locale-covered keys with safe defaults', () => {
  const dock = dockPrototype();
  for (const [method, field, states, fallback] of [
    ['runtimeLabel', 'runtimeState', ['ready', 'starting', 'error', 'stopped', 'unknown'], 'SUBAPP_DOCK.RUNTIME_UNKNOWN'],
    ['invocationLabel', 'invocationState', ['running', 'succeeded', 'failed', 'cancelled', 'idle'], 'SUBAPP_DOCK.INVOCATION_IDLE'],
  ]) {
    const keys = states.map(state => dock[method]({ [field]: state }));
    assert.equal(new Set(keys).size, states.length);
    for (const key of keys) {
      assert.match(key, /^SUBAPP_DOCK\.[A-Z_]+$/);
      for (const [lang, dictionary] of Object.entries(dictionaries)) assert.ok(dictionary[key.slice('SUBAPP_DOCK.'.length)], lang + ':' + key);
    }
    assert.equal(dock[method]({ [field]: 'future-state' }), fallback);
    assert.equal(dock[method]({}), fallback);
  }
});

test('the real Angular template translates text, tooltips, and icon button accessible names', async () => {
  const nodes = await templateNodes();
  const expressions = nodes.map(node => node.value?.source).filter(Boolean);
  for (const name of ['runtimeLabel(activity)', 'invocationLabel(activity)', 'activityTitle(activity)']) {
    assert.ok(expressions.some(source => source.includes(name + ' | translate')), name);
  }
  for (const key of ['OPEN_EMBEDDED', 'COLLAPSE']) {
    const matches = nodes.filter(node => node.value?.ast?.constructor.name === 'BindingPipe' && node.value.ast.name === 'translate' && node.value.ast.exp.value === 'SUBAPP_DOCK.' + key);
    assert.deepEqual(matches.map(node => node.name).sort(), ['aria-label', 'title']);
  }
  const windowLabels = nodes.filter(node => node.value?.ast?.constructor.name === 'BindingPipe'
    && node.value.ast.name === 'translate' && node.value.source.includes('SUBAPP_DOCK.OPEN_WINDOW')
    && node.value.source.includes('SUBAPP_DOCK.OPEN_FULL'));
  assert.deepEqual(windowLabels.map(node => node.name).sort(), ['aria-label', 'title']);
  assert.ok(nodes.some(node => node.name === 'aria-label' && node.value?.ast?.exp?.value === 'SUBAPP_DOCK.LABEL'));
  const staticText = nodes.filter(node => typeof node.value === 'string').map(node => node.value.trim()).filter(Boolean);
  assert.deepEqual(staticText, ['·'], 'shell text must go through translation; activity/error data stays data-bound');
});

test('Dock launch actions select embedded or separate-window mode for the same debugger', async () => {
  const dock = dockPrototype(), calls = [];
  const owner = { mainUiAutomation: { openChildApp: async input => calls.push(input) } };
  for (const toolId of ['serial-debugger', 'mqtt-debugger', 'network-debugger']) {
    await dock.openFull.call(owner, { toolId }, 'embedded');
    await dock.openFull.call(owner, { toolId }, 'window');
  }
  await dock.openFull.call(owner, { toolId: 'ffs-manager-child' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ...['serial-debugger', 'mqtt-debugger', 'network-debugger'].flatMap(toolId => [
      { toolId, mode: 'embedded' }, { toolId, mode: 'window' },
    ]),
    { toolId: 'ffs-manager-child', mode: 'embedded' },
  ]);
});

test('call counts use one translated interpolation instead of English singular/plural fragments', async () => {
  const nodes = await templateNodes();
  const count = nodes.find(node => node.value?.source?.includes('SUBAPP_DOCK.CALL_COUNT'));
  assert.ok(count);
  const pipe = count.value.ast.expressions[0];
  assert.equal(pipe.name, 'translate');
  assert.equal(pipe.exp.value, 'SUBAPP_DOCK.CALL_COUNT');
  assert.equal(pipe.args.length, 1);
  assert.deepEqual(pipe.args[0].keys.map(key => key.key), ['count']);
  const property = pipe.args[0].values[0];
  assert.equal(property.name, 'invocationCount');
  assert.equal(property.receiver.name, 'activity');
});

test('surface waiting, loading, stopped, retention, and failure headings use the same translated shell', async () => {
  const surface = path.join(root, 'src/app/tools/child-tool-surface-host/child-tool-surface-host.component');
  const nodes = await templateNodes(surface + '.html');
  const expressions = nodes.map(node => node.value?.source).filter(Boolean);
  for (const key of ['WAITING_RUNTIME', 'LOADING_SURFACE', 'RUNTIME_STOPPED', 'RUNTIME_NOT_RETAINED', 'SURFACE_ERROR']) {
    assert.ok(expressions.some(source => source.includes('SUBAPP_DOCK.' + key) && source.includes('| translate')), key);
  }
  assert.deepEqual(nodes.filter(node => typeof node.value === 'string').map(node => node.value.trim()).filter(Boolean), []);
  const diagnostics = nodes.filter(node => node.name === 'small' && node.children.some(child => child.value?.source?.trim() === '{{ errorMessage }}'));
  assert.equal(diagnostics.length, 1, 'the original diagnostic stays separate from the localized failure heading');
  const source = ts.createSourceFile(surface + '.ts', fs.readFileSync(surface + '.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const translateImport = source.statements.find(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@ngx-translate/core');
  assert.ok(translateImport.importClause.namedBindings.elements.some(node => node.name.text === 'TranslateModule'));
  const declaration = source.statements.find(ts.isClassDeclaration);
  const decorator = ts.getDecorators(declaration).find(node => node.expression.expression.text === 'Component');
  const imports = decorator.expression.arguments[0].properties.find(node => node.name?.text === 'imports');
  assert.ok(imports.initializer.elements.some(node => node.text === 'TranslateModule'));
});

test('the translated surface accessible title preserves tool and surface identifiers as interpolation parameters', async () => {
  const surface = path.join(root, 'src/app/tools/child-tool-surface-host/child-tool-surface-host.component.html');
  const nodes = await templateNodes(surface);
  const title = nodes.find(node => node.name === 'title');
  assert.ok(title);
  const pipe = title.value.ast;
  assert.equal(pipe.name, 'translate');
  assert.equal(pipe.exp.value, 'SUBAPP_DOCK.SURFACE_TITLE');
  assert.equal(pipe.args.length, 1);
  assert.deepEqual(pipe.args[0].keys.map(key => key.key), ['toolId', 'surface']);
  assert.deepEqual(pipe.args[0].values.map(value => value.name), ['toolId', 'surface']);
});
