'use strict';
// Product contract introduced by cloud-builder2 (32b528613): the signed cloud
// recipe owns firmware/resources/tool versions; the desktop binds local paths.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const protocol = require('../../electron/cloud-build/protocol');
const { validateCloudRecipePlan } = require('../../electron/cloud-build/cloud-recipe-contract');
const { checkedRecipe, cloudUploadRequirements, bindRecipe } = require('../../electron/cloud-build/cloud-recipe-upload');
const { boardUploadConfig, networkUploadConfig, verifyStagedUpload } = require('../../electron/cloud-build/cloud-upload-runtime');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-builder2-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('signed application firmware');
  const artifact = { artifactId: 'firmware', path: 'firmware.bin', role: 'firmware', sizeBytes: bytes.length, sha256: protocol.sha256(bytes) };
  const recipe = { schemaVersion: 1, hostPlatform: 'win32', hostArch: 'x64', fqbn: 'vendor:arch:test',
    sdkIdentity: { package: '@aily-project/sdk-test', version: '1.0.0',
      sourceFiles: ['boards.txt', 'platform.txt'].map(name => ({ path: name, sha256: 'b'.repeat(64) })) },
    tools: [{ id: 'esptool_py', package: '@aily-project/tool-esptool_py', version: '5.0.0' }], sdkAssets: [],
    upload: { command: '"__AILY_TOOL_esptool_py__/esptool.exe" write_flash 0x0 "__AILY_BUILD__/firmware.bin"',
      toolName: 'esptool_py', use1200bpsTouch: false, waitForUploadPort: false },
    boardOverrides: { uploadParam: null, linkUploadParam: null },
  };
  const plan = { schemaVersion: 1, profileDigest: 'a'.repeat(64), protocol: 'cloud-recipe', uploaderId: 'windows-sdk', targetChip: 'test',
    options: {}, lifecycle: { reset: 'cloud-recipe', verify: true },
    segments: [{ artifactId: artifact.artifactId, path: artifact.path, sha256: artifact.sha256 }], recipe };
  const pkg = { name: '@aily-project/board-test', version: '1.0.0', boardDependencies: {
    '@aily-project/sdk-test': '1.0.0', '@aily-project/tool-esptool_py': '5.0.0',
  } };
  const board = { uploadParam: 'old local override' }, boardRoot = path.join(root, 'node_modules', pkg.name);
  fs.mkdirSync(boardRoot, { recursive: true });
  fs.writeFileSync(path.join(boardRoot, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(boardRoot, 'board.json'), JSON.stringify(board));
  const manifest = { schemaVersion: 1, kind: 'aily-cloud-build-result', action: 'compile', runner: 'aily-builder', fixture: false,
    profileDigest: plan.profileDigest, boardModule: pkg.name, boardVersion: pkg.version,
    boardDigest: protocol.boardDigest(pkg, board), artifacts: [artifact], flashPlan: plan };
  const keys = crypto.generateKeyPairSync('ed25519');
  const record = { root, manifest, profile: { fqbn: recipe.fqbn },
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), signature: null };
  const sign = () => { record.signature = { algorithm: 'Ed25519',
    value: crypto.sign(null, Buffer.from(protocol.canonicalJson(manifest)), keys.privateKey).toString('base64') }; };
  sign();
  return { root, bytes, artifact, recipe, plan, record, sign };
}

test('signed cloud recipe requires only exact uploader tools without an installed SDK', t => {
  const f = fixture(t);
  assert.equal(checkedRecipe(f.record), f.recipe);
  assert.deepEqual(cloudUploadRequirements(f.record), { protocol: 'cloud-recipe', requirements: [
    { kind: 'tool', id: 'esptool_py', name: '@aily-project/tool-esptool_py', version: '5.0.0' },
  ] });
  assert.equal(fs.existsSync(path.join(f.root, 'sdk')), false);
});

for (const [name, change] of [
  ['compiler package', f => f.recipe.tools.push({ id: 'arm-none-eabi-gcc', package: '@aily-project/tool-arm-none-eabi-gcc', version: '1.0.0' })],
  ['version range', f => { f.recipe.tools[0].version = '^5.0.0'; }],
  ['unaccounted signed artifact', f => f.record.manifest.artifacts.push({ ...f.artifact, artifactId: 'extra', path: 'extra.bin' })],
  ['worker absolute path', f => { f.recipe.upload.command = '"C:/worker/esptool.exe" write_flash firmware.bin'; }],
]) test(`rejects a recipe containing ${name}`, t => {
  const f = fixture(t); change(f);
  assert.throws(() => validateCloudRecipePlan(f.plan, f.record.manifest.artifacts), { code: 'CLOUD_RECIPE_INVALID' });
});

test('changing a signed tool version cannot bypass signature verification', t => {
  const f = fixture(t); f.recipe.tools[0].version = '6.0.0';
  assert.throws(() => checkedRecipe(f.record), { code: 'SIGNATURE_INVALID' });
});

test('signed recipe dependencies must still match the installed board declaration', t => {
  const f = fixture(t); f.recipe.sdkIdentity.version = '2.0.0'; f.sign();
  assert.throws(() => checkedRecipe(f.record), { code: 'BUILD_SOURCE_STALE' });
});

test('desktop binds recipe paths without expanding unknown local tool roots', () => {
  assert.deepEqual(bindRecipe({ command: '"__AILY_TOOL_esptool_py__/esptool.exe" "__AILY_BUILD__/firmware.bin"' }, {
    __AILY_TOOL_esptool_py__: 'C:\\Aily\\tools\\esptool_py@5.0.0', __AILY_BUILD__: 'C:/staged/build',
  }), { command: '"C:/Aily/tools/esptool_py@5.0.0/esptool.exe" "C:/staged/build/firmware.bin"' });
  assert.throws(() => bindRecipe('__AILY_TOOL_missing__/flash.exe', {}), { code: 'UPLOAD_UNSUPPORTED' });
});

test('local upload uses cloud-resolved overrides and a fixed signed inventory', t => {
  const f = fixture(t);
  const staged = { buildPath: path.join(f.root, 'staged'), toolsPath: path.join(f.root, 'uploader-tools'),
    cloudRecipeBoardOverrides: { uploadParam: { param: 'signed override', flags: { use_1200bps_touch: true } } },
    uploadArtifactInventory: { primary: 'firmware.bin', files: ['firmware.bin'] } };
  const config = boardUploadConfig(f.record, { serialPort: 'COM3', portType: 'serial' }, staged, f.root);
  assert.equal(config.uploadParam, 'signed override');
  assert.equal(config.use_1200bps_touch, true);
  assert.equal(config.restrictToolSearch, true);
  assert.equal(config.toolsPath, staged.toolsPath);
  assert.deepEqual(config.uploadArtifactInventory, staged.uploadArtifactInventory);
});

test('network OTA uses the signed primary BIN and verifies its staged bytes', t => {
  const f = fixture(t), staged = { buildPath: path.join(f.root, 'staged') };
  fs.mkdirSync(staged.buildPath);
  const filename = path.join(staged.buildPath, 'firmware.bin'); fs.writeFileSync(filename, f.bytes);
  const request = { networkTarget: { host: '192.0.2.1', port: 80, username: '', password: '', uploadPath: '/update', ssl: false, timeoutMs: 30000 } };
  assert.equal(networkUploadConfig(f.record, request, staged).firmwarePath, filename);
  verifyStagedUpload(f.record, staged);
  fs.writeFileSync(filename, 'modified');
  assert.throws(() => verifyStagedUpload(f.record, staged), { code: 'ARTIFACT_INVALID' });
});
