'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const rxjs = require('rxjs');

const hostRoot = path.resolve(__dirname, '..');
const sources = {
  registry: path.join(hostRoot, 'src/app/configs/tool.config.ts'),
  loader: path.join(hostRoot, 'src/app/services/core/preferences/tool-i18n.service.ts'),
};

function fixture(t) {
  const base = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'aily-tool-i18n-generation-'));
  t.after(() => {
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith('aily-tool-i18n-generation-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const reads = [], calls = [], warnings = [], requests = [], dictionaries = new Map();
  const language = new rxjs.Subject();
  const inside = value => {
    const file = path.resolve(String(value));
    assert.ok(file.startsWith(root + path.sep), 'read must stay within this owned fixture');
    return file;
  };
  const windowPort = {
    fs: {
      existsSync(file) { return fs.existsSync(inside(file)); },
      readFileSync(file, encoding) { file = inside(file); reads.push(path.relative(root, file)); return fs.readFileSync(file, encoding); },
    },
    path: { join: path.join, getAilyChildPath: () => root },
  };
  function compile(name, requirePort) {
    const result = ts.transpileModule(fs.readFileSync(sources[name], 'utf8'), {
      fileName: sources[name],
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
      reportDiagnostics: true,
    });
    assert.equal(result.diagnostics.length, 0);
    const module = { exports: {} };
    vm.runInNewContext(result.outputText, {
      module, exports: module.exports, require: requirePort, window: windowPort,
      console: { warn: (...args) => warnings.push(args) },
    }, { filename: sources[name] });
    return module.exports;
  }
  const registry = compile('registry', name => { throw new Error('Unexpected registry dependency: ' + name); });
  const { ToolI18nService } = compile('loader', name => {
    if (name === '@angular/core') return { Injectable: () => value => value };
    if (name === 'rxjs') return rxjs;
    if (name === '../../../configs/tool.config') return registry;
    if (name === '@angular/common/http' || name === '@ngx-translate/core') return {};
    throw new Error('Unexpected loader dependency: ' + name);
  });
  const translate = {
    currentLang: 'en', defaultLang: 'en', onLangChange: language,
    setTranslation(lang, data, merge) {
      calls.push({ lang, data: JSON.parse(JSON.stringify(data)), merge });
      dictionaries.set(lang, data);
    },
  };
  const service = new ToolI18nService({
    get(url) { const subject = new rxjs.Subject(); requests.push({ url, subject }); return subject; },
  }, translate);
  function config(name, version = '0.1.0') {
    return { id: 'ble-debugger', titleKey: 'BLE_DEBUGGER.TITLE', namespace: 'BLE_DEBUGGER', packagePath: path.join(root, name), version };
  }
  function select(name, version) { registry.replaceChildToolConfigs([config(name, version)]); }
  function write(name, lang, title) {
    const dir = path.join(root, name, 'i18n'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, lang + '.json'), JSON.stringify(bundle(title)));
  }
  return { root, reads, calls, warnings, requests, dictionaries, language, translate, service, registry, select, write };
}
function bundle(title) { return { BLE_DEBUGGER: { TITLE: title, DESCRIPTION: title + ' description' } }; }
function complete(request, title) { request.subject.next(bundle(title)); request.subject.complete(); }
const turn = () => new Promise(resolve => setImmediate(resolve));
const title = (f, lang = 'en') => f.dictionaries.get(lang)?.BLE_DEBUGGER.TITLE;

test('same source and language share one real read and a completed cache entry', async t => {
  const f = fixture(t); f.write('a', 'en', 'A'); f.select('a');
  const first = f.service.load('ble-debugger', 'en');
  const second = f.service.load('ble-debugger', 'en');
  assert.equal(first, second);
  await Promise.all([first, second]);
  await f.service.load('ble-debugger', 'en');
  assert.equal(title(f), 'A'); assert.equal(f.reads.length, 1); assert.equal(f.calls.length, 1);
});

test('a different selected package generation reads and publishes its own file', async t => {
  const f = fixture(t); f.write('a', 'en', 'A'); f.write('b', 'en', 'B');
  f.select('a', '0.1.0'); await f.service.load('ble-debugger', 'en');
  f.select('b', '0.1.1'); await f.service.load('ble-debugger', 'en');
  assert.equal(title(f), 'B');
  assert.equal(f.reads.length, 2); assert.ok(f.reads[1].startsWith('b' + path.sep));
});

test('a new registry snapshot invalidates even the same physical path and version', async t => {
  const f = fixture(t); f.write('same', 'en', 'BEFORE'); f.select('same', '0.1.0');
  const original = f.registry.getChildToolConfig('ble-debugger');
  await f.service.load('ble-debugger', 'en');
  f.write('same', 'en', 'AFTER'); f.select('same', '0.1.0');
  assert.notEqual(f.registry.getChildToolConfig('ble-debugger'), original);
  await f.service.load('ble-debugger', 'en');
  assert.equal(title(f), 'AFTER'); assert.equal(f.reads.length, 2);
});

test('a late result from the old source cannot overwrite the new source', async t => {
  const f = fixture(t); f.select('a', '0.1.0');
  const old = f.service.load('ble-debugger', 'en'); await turn();
  f.select('b', '0.1.1'); const current = f.service.load('ble-debugger', 'en'); await turn();
  assert.equal(f.requests.length, 2);
  complete(f.requests[1], 'B'); await current;
  complete(f.requests[0], 'A'); await old;
  assert.equal(title(f), 'B'); assert.equal(f.calls.length, 1);
  await f.service.load('ble-debugger', 'en'); assert.equal(f.requests.length, 2);
});

test('stale failure and finally preserve the new pending request; current failures remain retryable', async t => {
  const f = fixture(t); f.select('a', '0.1.0');
  const old = f.service.load('ble-debugger', 'en'); await turn();
  f.select('b', '0.1.1'); const current = f.service.load('ble-debugger', 'en'); await turn();
  f.requests[0].subject.error(new Error('old source failed')); await old;
  assert.equal(f.warnings.length, 0);
  assert.equal(f.service.load('ble-debugger', 'en'), current); assert.equal(f.requests.length, 2);
  complete(f.requests[1], 'B'); await current;
  const failed = f.service.load('ble-debugger', 'en', true); await turn();
  f.requests[2].subject.error(new Error('current source failed')); await failed;
  assert.equal(f.warnings.length, 1);
  const retry = f.service.load('ble-debugger', 'en'); await turn();
  assert.equal(f.requests.length, 4); complete(f.requests[3], 'RETRY'); await retry;
  assert.equal(title(f), 'RETRY');
});

test('force coalesces a pending request and re-reads a completed source', async t => {
  const f = fixture(t); f.write('a', 'en', 'A'); f.select('a');
  const first = f.service.load('ble-debugger', 'en');
  assert.equal(f.service.load('ble-debugger', 'en', true), first); await first;
  f.write('a', 'en', 'FORCED');
  await f.service.load('ble-debugger', 'en', true);
  assert.equal(title(f), 'FORCED'); assert.equal(f.reads.length, 2);
});

test('parallel language preloads and language changes keep independent current entries', async t => {
  const f = fixture(t); f.write('a', 'en', 'EN'); f.write('a', 'zh_cn', '中文'); f.select('a');
  const en = f.service.load('ble-debugger', 'en'), zh = f.service.load('ble-debugger', 'zh_cn');
  assert.notEqual(en, zh); await Promise.all([en, zh]);
  assert.equal(title(f, 'en'), 'EN'); assert.equal(title(f, 'zh_cn'), '中文');
  f.write('a', 'en', 'EN NEW'); f.translate.currentLang = 'en'; f.language.next({ lang: 'en' });
  await f.service.load('ble-debugger', 'en');
  f.write('a', 'zh_cn', '新中文'); f.translate.currentLang = 'zh_cn'; f.language.next({ lang: 'zh_cn' });
  await f.service.load('ble-debugger', 'zh_cn');
  assert.equal(title(f, 'en'), 'EN NEW'); assert.equal(title(f, 'zh_cn'), '新中文'); assert.equal(f.reads.length, 4);
});

test('out-of-order independent language requests both publish their own language', async t => {
  const f = fixture(t);
  const en = f.service.load('app-store', 'en'), zh = f.service.load('app-store', 'zh_cn'); await turn();
  const english = f.requests.find(r => r.url.endsWith('/en.json'));
  const chinese = f.requests.find(r => r.url.endsWith('/zh_cn.json'));
  assert.ok(english && chinese);
  complete(chinese, '中文'); await zh; complete(english, 'EN'); await en;
  assert.equal(title(f, 'en'), 'EN'); assert.equal(title(f, 'zh_cn'), '中文'); assert.equal(f.calls.length, 2);
});

