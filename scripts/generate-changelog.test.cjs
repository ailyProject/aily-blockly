const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const blocklyFile = 'src/app/editors/blockly-editor/components/blockly/plugins/toolbox-search/src/index.ts';
const coderFile = 'src/app/integrations/coder/coder-project-runtime.service.ts';
const sharedFile = 'src/app/editors/blockly-editor/services/uploader.service.ts';
const diffFor = (file, change) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${change}\n`;
const commit = (files, title, diff) => ({ sha: 'a'.repeat(40), title, body: 'User-visible behavior changed.', files, diff });

async function generate(t, evidence, { ai = true, fail = false, product = 'coder', bullet = 'Improved Coder upload reliability.' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-changelog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'commits.json');
  const enFile = path.join(directory, 'CHANGELOG_CODER.md');
  const zhFile = path.join(directory, 'CHANGELOG_CODER_ZH.md');
  fs.writeFileSync(input, typeof evidence === 'string' ? evidence : JSON.stringify(evidence));
  const prompts = [];
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^AI_(?:BASE_URL|API_KEY|MODEL|COMPLETIONS_PATH)[23]?$/.test(key)) delete env[key];
  }
  Object.assign(env, {
    RELEASE_VERSION: '0.1.7', RELEASE_PRODUCT: product,
    CHANGELOG_COMMITS_FILE: input, CHANGELOG_EN_FILE: enFile, CHANGELOG_ZH_FILE: zhFile,
  });
  if (ai) {
    const server = http.createServer(async (request, response) => {
      let data = '';
      for await (const chunk of request) data += chunk;
      const prompt = JSON.parse(data).messages[0].content;
      prompts.push(prompt);
      if (fail) {
        response.writeHead(400).end('AI unavailable');
        return;
      }
      const chinese = prompt.includes('## Source Markdown');
      const content = chinese
        ? '## 0.1.7\n### 更新内容\n🔧 体验改进\n- 改善 Coder 上传可靠性。'
        : `## 0.1.7\n### Changes\n🔧 Improvements\n- ${bullet}`;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    Object.assign(env, {
      AI_BASE_URL: `http://127.0.0.1:${server.address().port}`, AI_API_KEY: 'test-only',
      AI_MODEL: 'test-model', AI_COMPLETIONS_PATH: 'generate',
    });
  }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'generate-changelog.js')], { env, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(output)));
  });
  return { prompts, en: fs.readFileSync(enFile, 'utf8'), zh: fs.readFileSync(zhFile, 'utf8') };
}

function promptEvidence(prompt) {
  return JSON.parse(prompt.split('Raw commit records:\n')[1].split('\n\n## Your task')[0]);
}

test('Coder changes retain SHA, title, body and bounded diff for the existing bilingual AI path', async t => {
  const input = commit([coderFile], 'Fix project upload', diffFor(coderFile, 'retry upload in active Coder project'));
  const result = await generate(t, [input]);
  assert.deepEqual(promptEvidence(result.prompts[0])[0], { ...input, excludedFiles: [] });
  assert.match(result.prompts[0], /Target product: Aily Coder/);
  assert.match(result.en, /Improved Coder upload reliability/);
  assert.ok(result.prompts[1].includes(result.en));
  assert.match(result.zh, /改善 Coder 上传可靠性/);
});

test('confirmed Blockly-only commits use neutral bilingual notes without asking AI', async t => {
  const result = await generate(t, [commit([blocklyFile], 'Improve toolbox search', diffFor(blocklyFile, 'new Blockly toolbox search'))]);
  assert.equal(result.prompts.length, 0);
  assert.match(result.en, /Maintenance and dependency updates/);
  assert.match(result.zh, /维护和依赖更新/);
  assert.doesNotMatch(result.en + result.zh, /toolbox/);
});

test('shared upload and board helpers remain eligible despite historical Blockly directory names', async t => {
  const boardFile = 'src/app/editors/blockly-editor/components/blockly/abf.ts';
  const input = commit([sharedFile, boardFile], 'Fix upload after changing boards', diffFor(sharedFile, 'retry shared upload'));
  const result = await generate(t, [input]);
  assert.deepEqual(promptEvidence(result.prompts[0])[0].files, input.files);
  assert.match(result.prompts[0], /Shared changes may appear in both products/);
});

test('mixed commits remove Blockly-only diff and restrict summaries to supported Coder impact', async t => {
  const input = commit([blocklyFile, coderFile], 'Fix toolbox search and Coder upload',
    diffFor(blocklyFile, 'Blockly-only toolbox implementation') + diffFor(coderFile, 'Coder upload retry'));
  const result = await generate(t, [input]);
  const filtered = promptEvidence(result.prompts[0])[0];
  assert.deepEqual(filtered.files, [coderFile]);
  assert.deepEqual(filtered.excludedFiles, [blocklyFile]);
  assert.doesNotMatch(filtered.diff, /Blockly-only toolbox implementation/);
  assert.match(filtered.diff, /Coder upload retry/);
  assert.match(result.prompts[0], /describe ONLY the supported Coder impact/);
  assert.doesNotMatch(result.en + result.zh, /toolbox/);
});

test('AI failure, missing AI config and malformed evidence never fall back to raw Coder commits', async t => {
  const evidence = [commit([coderFile], 'DO_NOT_PUBLISH_RAW_COMMIT', diffFor(coderFile, 'private implementation context'))];
  for (const options of [{ fail: true }, { ai: false }, { malformed: true }]) {
    const result = await generate(t, options.malformed ? 'legacy unstructured DO_NOT_PUBLISH_RAW_COMMIT' : evidence, options);
    assert.match(result.en, /Maintenance and dependency updates/);
    assert.match(result.zh, /维护和依赖更新/);
    assert.doesNotMatch(result.en + result.zh, /DO_NOT_PUBLISH|private implementation/);
  }
});

test('existing Blockly callers keep their plain commit input and product-neutral prompt', async t => {
  const result = await generate(t, 'Improve Blockly toolbox search', { product: '', bullet: 'Improved toolbox search.' });
  assert.match(result.prompts[0], /Raw commit records:\nImprove Blockly toolbox search/);
  assert.doesNotMatch(result.prompts[0], /Target product: Aily Coder/);
  assert.match(result.en, /Improved toolbox search/);
});
