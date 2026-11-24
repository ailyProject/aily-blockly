'use strict';
// Product contract introduced by cloud-builder2 (32b528613): the signed cloud
// recipe owns firmware/resources/tool versions; the desktop binds local paths.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const protocol = require('../../electron/cloud-build/protocol');
const { validateCloudRecipePlan } = require('../../electron/cloud-build/cloud-recipe-contract');
const { checkedRecipe, cloudUploadRequirements, bindRecipe, stageCloudRecipeUpload } = require('../../electron/cloud-build/cloud-recipe-upload');
const { boardUploadConfig, localDependencyPath, networkUploadConfig, runCloudUpload, verifyStagedUpload } = require('../../electron/cloud-build/cloud-upload-runtime');

const mac = { platform: 'darwin', arch: 'arm64' };
const windows = { platform: 'win32', arch: 'x64' };
const esptool = { id: 'esptool_py', package: '@aily-project/tool-esptool_py', version: '5.3.0' };
const networkTarget = { host: '192.0.2.1', port: 80, username: '', password: '', uploadPath: '/update', ssl: false, timeoutMs: 30000 };
const reference = ({ artifactId, path, sha256 }) => ({ artifactId, path, sha256 });

function signedFixture(t, { pkg, board, recipe, chip, firmware, sdkAssets = [] }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-builder2-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'downloaded');
  const writeArtifact = ({ filename, bytes, role }, index) => {
    const local = path.join(directory, ...filename.split('/'));
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, bytes);
    return { artifactId: `signed-${index}`, path: filename, role, sizeBytes: bytes.length, sha256: protocol.sha256(bytes) };
  };
  const artifacts = [...firmware, ...sdkAssets].map(writeArtifact);
  recipe.sdkAssets = sdkAssets.map(({ sdkPath, kind }, index) => ({
    ...reference(artifacts[firmware.length + index]), sdkPath, kind,
  }));
  const plan = { schemaVersion: 1, profileDigest: 'a'.repeat(64), protocol: 'cloud-recipe', uploaderId: 'windows-sdk', targetChip: chip,
    options: {}, lifecycle: { reset: 'cloud-recipe', verify: true },
    segments: artifacts.slice(0, firmware.length).map(reference), recipe };
  const boardRoot = path.join(root, 'node_modules', pkg.name);
  fs.mkdirSync(boardRoot, { recursive: true });
  fs.writeFileSync(path.join(boardRoot, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(boardRoot, 'board.json'), JSON.stringify(board));
  const manifest = { schemaVersion: 1, kind: 'aily-cloud-build-result', action: 'compile', runner: 'aily-builder', fixture: false,
    profileDigest: plan.profileDigest, boardModule: pkg.name, boardVersion: pkg.version,
    boardDigest: protocol.boardDigest(pkg, board), artifacts, flashPlan: plan };
  const keys = crypto.generateKeyPairSync('ed25519');
  const record = { root, directory, manifest, profile: { fqbn: recipe.fqbn.split(':').slice(0, 3).join(':') },
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), signature: null };
  const sign = () => { record.signature = { algorithm: 'Ed25519',
    value: crypto.sign(null, Buffer.from(protocol.canonicalJson(manifest)), keys.privateKey).toString('base64') }; };
  sign();
  return { root, recipe, plan, record, sign };
}

function fixture(t) {
  const bytes = Buffer.from('signed application firmware');
  const recipe = { schemaVersion: 1, hostPlatform: 'win32', hostArch: 'x64', fqbn: 'vendor:arch:test',
    sdkIdentity: { package: '@aily-project/sdk-test', version: '1.0.0',
      sourceFiles: ['boards.txt', 'platform.txt'].map(name => ({ path: name, sha256: 'b'.repeat(64) })) },
    tools: [{ id: 'esptool_py', package: '@aily-project/tool-esptool_py', version: '5.0.0' }], sdkAssets: [],
    upload: { command: '"__AILY_TOOL_esptool_py__/esptool.exe" write_flash 0x0 "__AILY_BUILD__/firmware.bin"',
      toolName: 'esptool_py', use1200bpsTouch: false, waitForUploadPort: false },
    boardOverrides: { uploadParam: null, linkUploadParam: null },
  };
  const pkg = { name: '@aily-project/board-test', version: '1.0.0', boardDependencies: {
    '@aily-project/sdk-test': '1.0.0', '@aily-project/tool-esptool_py': '5.0.0',
  } };
  const signed = signedFixture(t, { pkg, board: { uploadParam: 'old local override' }, recipe, chip: 'test',
    firmware: [{ filename: 'firmware.bin', role: 'firmware', bytes }] });
  return { ...signed, bytes, artifact: signed.record.manifest.artifacts[0] };
}

test('signed cloud recipe requires only exact uploader tools without an installed SDK', t => {
  const f = fixture(t);
  assert.equal(checkedRecipe(f.record), f.recipe);
  assert.deepEqual(cloudUploadRequirements(f.record, { ...windows, portType: 'serial' }), { protocol: 'cloud-recipe', requirements: [
    { kind: 'tool', id: 'esptool_py', name: '@aily-project/tool-esptool_py', version: '5.0.0' },
  ] });
  assert.equal(fs.existsSync(path.join(f.root, 'sdk')), false);
});

function linkbitFixture(t, primary = 'sketch.bin') {
  const sdk = '@aily-project/sdk-esp32';
  const pkg = { name: '@aily-project/board-linkbit_3c', version: '3.3.10', boardDependencies: {
    [sdk]: '3.3.10', [esptool.package]: esptool.version,
  } };
  const recipe = { schemaVersion: 1, hostPlatform: 'win32', hostArch: 'x64',
    fqbn: 'esp32:esp32:esp32c3:PartitionScheme=default,FlashSize=4M,UploadSpeed=921600',
    sdkIdentity: { package: sdk, version: '3.3.10', sourceFiles: ['boards.txt', 'platform.txt'].map(filename => ({ path: filename, sha256: 'b'.repeat(64) })) },
    tools: [esptool], boardOverrides: { uploadParam: null, linkUploadParam: null },
    upload: { toolName: esptool.id, use1200bpsTouch: false, waitForUploadPort: false, command: [
      '"__AILY_SDK__\\tools\\flasher.exe" --esptool "__AILY_TOOL_esptool_py__/esptool.exe" --build-dir "__AILY_BUILD__"',
      '--chip esp32c3 --port "${serial}" --baud 921600  --before default-reset --after hard-reset',
      'write-flash  -z --flash-mode keep --flash-freq keep --flash-size keep',
      '0x0 "__AILY_BUILD__/sketch.bootloader.bin" 0x8000 "__AILY_BUILD__/sketch.partitions.bin"',
      '0xe000 "__AILY_SDK__/tools/partitions/boot_app0.bin"',
      `0x10000 "__AILY_BUILD__/${primary}"`,
    ].join(' ') },
  };
  const firmware = [
    { filename: primary, role: 'firmware', bytes: Buffer.alloc(338560, 0xe9) },
    { filename: 'sketch.bootloader.bin', role: 'auxiliary', bytes: Buffer.alloc(18672, 0x11) },
    { filename: 'sketch.partitions.bin', role: 'auxiliary', bytes: Buffer.alloc(3072, 0x22) },
  ];
  const sdkAssets = [
    { sdkPath: 'tools/flasher.exe', kind: 'executable', bytes: Buffer.from('Windows wrapper fixture') },
    { sdkPath: 'tools/partitions/boot_app0.bin', kind: 'static', bytes: Buffer.alloc(8192, 0x33) },
  ].map(item => ({ ...item, filename: 'upload-resources/' + item.sdkPath, role: 'upload-resource' }));
  return signedFixture(t, { pkg, board: { type: 'esp32:esp32:esp32c3' }, recipe, chip: 'esp32c3', firmware, sdkAssets });
}

function toolFixture(appDataPath) {
  const wrapper = path.join(appDataPath, 'node_modules', esptool.package, 'package.json');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, JSON.stringify({ name: esptool.package, version: esptool.version }));
  const directory = path.join(appDataPath, 'tools', `${esptool.id}@${esptool.version}`);
  fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, 'esptool');
  fs.writeFileSync(executable, 'uploader fixture for intercepted launch', { mode: 0o755 });
  return { directory, executable };
}

function stageOptions(f, platform, portType) {
  const workspace = path.join(f.root, 'staged upload');
  fs.mkdirSync(workspace);
  return { ...platform, workspace, portType, appDataPath: f.root, sourceIdentity: { entry: 'sketch/sketch.ino' },
    signal: new AbortController().signal };
}

function interceptLaunch(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
}

test('macOS stages signed LinkBit artifacts and launches native esptool with the verified offsets', async t => {
  const f = linkbitFixture(t);
  const requirement = { kind: 'tool', id: esptool.id, name: esptool.package, version: esptool.version };
  assert.deepEqual(cloudUploadRequirements(f.record, { ...mac, portType: 'serial' }), {
    protocol: 'cloud-recipe', nativeSerial: true, requirements: [requirement],
  });
  const tool = toolFixture(f.root);
  const options = stageOptions(f, mac, 'serial');
  const staged = await stageCloudRecipeUpload(f.record, options);
  assert.equal(staged.nativeUpload.transport, 'serial');
  assert.equal(staged.preprocessPath, undefined);
  assert.equal(fs.existsSync(path.join(options.workspace, 'tools')), false);
  assert.deepEqual(staged.uploadArtifactInventory, {
    primary: 'sketch.bin', files: ['sketch.bin', 'sketch.bootloader.bin', 'sketch.partitions.bin'],
  });
  const port = '/dev/cu.usbmodem1101';
  const calls = [];
  let currentChecks = 0, delegated = 0;
  const runtime = { ...options, staged, launch: interceptLaunch(calls), assertCurrent: () => { currentChecks++; },
    markDelegated: () => { delegated++; } };
  const request = { portType: 'serial', serialPort: port };
  assert.equal((await runCloudUpload(f.record, request, runtime)).success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, tool.executable);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, staged.buildPath);
  assert.deepEqual(calls[0].args, [
    '--chip', 'esp32c3', '--port', port, '--baud', '921600', '--before', 'default-reset', '--after', 'hard-reset',
    'write-flash', '-z', '--flash-mode', 'keep', '--flash-freq', 'keep', '--flash-size', 'keep',
    '0x0', path.join(staged.buildPath, 'sketch.bootloader.bin'),
    '0x8000', path.join(staged.buildPath, 'sketch.partitions.bin'),
    '0xe000', path.join(staged.buildPath, 'upload-resources', 'tools', 'partitions', 'boot_app0.bin'),
    '0x10000', path.join(staged.buildPath, 'sketch.bin'),
  ]);
  assert.equal(currentChecks, 1);
  assert.equal(delegated, 1);
  assert.equal(fs.existsSync(path.join(options.workspace, 'upload-config.json')), false);

  await assert.rejects(runCloudUpload(f.record, { portType: 'network-ota', networkTarget }, runtime), { code: 'UPLOAD_INVALID' });
  const bootApp = path.join(staged.buildPath, 'upload-resources', 'tools', 'partitions', 'boot_app0.bin');
  fs.writeFileSync(bootApp, Buffer.alloc(fs.statSync(bootApp).size, 0x44));
  await assert.rejects(runCloudUpload(f.record, request, runtime), { code: 'ARTIFACT_INVALID' });
  assert.equal(calls.length, 1);
  assert.equal(delegated, 1);
});

test('Windows keeps the signed SDK wrapper and bound tool paths for the same LinkBit result', async t => {
  const f = linkbitFixture(t), tool = toolFixture(f.root);
  assert.deepEqual(cloudUploadRequirements(f.record, { ...windows, portType: 'serial' }), {
    protocol: 'cloud-recipe', requirements: [{ kind: 'tool', id: esptool.id, name: esptool.package, version: esptool.version }],
  });
  const options = stageOptions(f, windows, 'serial');
  const staged = await stageCloudRecipeUpload(f.record, options);
  assert.equal(staged.nativeUpload, undefined);
  const command = JSON.parse(fs.readFileSync(staged.preprocessPath, 'utf8')).upload.command.replace(/\\/gu, '/');
  assert.ok(command.includes(`"${path.join(staged.sdkDirectory, 'tools', 'flasher.exe').replace(/\\/gu, '/')}"`));
  assert.ok(command.includes(`"${path.join(tool.directory, 'esptool.exe').replace(/\\/gu, '/')}"`));
  const config = boardUploadConfig(f.record, { serialPort: 'COM3', portType: 'serial' }, staged, f.root);
  assert.equal(config.serialPort, 'COM3');
  assert.throws(() => boardUploadConfig(f.record, { serialPort: '/dev/cu.usbmodem1101', portType: 'serial' }, staged, f.root),
    { code: 'UPLOAD_INVALID' });
  verifyStagedUpload(f.record, staged);
});

for (const portType of ['network-ota', 'ble']) test(`macOS ${portType} needs no Windows SDK uploader for a signed ESP32 application BIN`, async t => {
  const f = linkbitFixture(t);
  assert.deepEqual(cloudUploadRequirements(f.record, { ...mac, portType }), { protocol: 'cloud-recipe', requirements: [] });
  const options = stageOptions(f, mac, portType);
  const staged = await stageCloudRecipeUpload(f.record, options);
  assert.equal(staged.nativeUpload.transport, portType);
  assert.equal(staged.uploadArtifactInventory.primary, 'sketch.bin');
  assert.equal(fs.existsSync(path.join(f.root, 'tools')), false);
  assert.equal(staged.preprocessPath, undefined);
  verifyStagedUpload(f.record, staged);
  if (portType === 'network-ota') {
    const calls = [];
    const result = await runCloudUpload(f.record, { portType, networkTarget }, {
      ...options, staged, assertCurrent() {}, launch: interceptLaunch(calls),
    });
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(path.basename(calls[0].args[0]), 'network-ota-upload.js');
    const config = JSON.parse(fs.readFileSync(calls[0].args[1], 'utf8'));
    assert.equal(config.firmwarePath, path.join(staged.buildPath, 'sketch.bin'));
  }
});

test('macOS OTA rejects unrelated or merged primary firmware and staging verifies the downloaded hash', async t => {
  for (const f of [fixture(t), linkbitFixture(t, 'sketch.merged.bin')]) {
    for (const portType of ['network-ota', 'ble']) {
      assert.throws(() => cloudUploadRequirements(f.record, { ...mac, portType }), { code: 'UPLOAD_UNSUPPORTED' });
    }
  }
  const f = linkbitFixture(t);
  const firmware = path.join(f.record.directory, 'sketch.bin');
  fs.writeFileSync(firmware, Buffer.alloc(fs.statSync(firmware).size, 0x55));
  await assert.rejects(stageCloudRecipeUpload(f.record, stageOptions(f, mac, 'network-ota')), { code: 'ARTIFACT_INVALID' });
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


test('cloud tools on Unix resolve the exact physical package from the isolated npm prefix',
  { skip: process.platform === 'win32' }, t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-cloud-tools-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const requirement = { kind: 'tool', name: '@aily-project/tool-citool-cli', id: 'citool-cli', version: '1.2.2' };
    const wrapper = path.join(root, '.aily-cloud-tools', 'lib', 'node_modules', '@aily-project', 'tool-citool-cli', 'package.json');
    const directory = path.join(root, 'tools', 'citool-cli@1.2.2');
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(wrapper, JSON.stringify({ name: requirement.name, version: requirement.version }));
    assert.deepEqual(localDependencyPath(root, requirement), { directory, runtimeVersion: '1.2.2' });
    fs.writeFileSync(wrapper, JSON.stringify({ name: requirement.name, version: '1.2.3' }));
    assert.throws(() => localDependencyPath(root, requirement), { code: 'UPLOADER_MISSING' });
  });
