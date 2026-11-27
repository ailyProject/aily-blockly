'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { macEsp32SerialPlan, macEsp32SerialArgs } = require('../../electron/cloud-build/cloud-esp32-upload');
const { validateCloudRecipePlan } = require('../../electron/cloud-build/cloud-recipe-contract');

const TOOL = '"__AILY_TOOL_esptool_py__/esptool.exe"';
const BOOT_APP = 'tools/partitions/boot_app0.bin';
const FLASHER = 'tools/flasher.exe';

function fixture({ wrapped = true, bootApp = true } = {}) {
  const artifact = (filename, role, sizeBytes, index) => ({
    path: filename, role, sizeBytes, artifactId: 'file-' + index, sha256: String(index).repeat(64),
  });
  const reference = ({ artifactId, path, sha256 }) => ({ artifactId, path, sha256 });
  const firmware = [
    artifact('sketch.bin', 'firmware', 338560, 1),
    artifact('sketch.bootloader.bin', 'auxiliary', 18672, 2),
    artifact('sketch.partitions.bin', 'auxiliary', 3072, 3),
  ];
  const resources = [];
  if (wrapped) resources.push({ ...artifact('upload-resources/' + FLASHER, 'upload-resource', 9464216, 4),
    sdkPath: FLASHER, kind: 'executable' });
  if (bootApp) resources.push({ ...artifact('upload-resources/' + BOOT_APP, 'upload-resource', 8192, 5),
    sdkPath: BOOT_APP, kind: 'static' });
  const recipe = {
    schemaVersion: 1, hostPlatform: 'win32', hostArch: 'x64',
    fqbn: 'esp32:esp32:esp32c3:PartitionScheme=default,FlashSize=4M,UploadSpeed=921600',
    sdkIdentity: { package: '@aily-project/sdk-esp32', version: '3.3.10',
      sourceFiles: ['boards.txt', 'platform.txt'].map(file => ({ path: file, sha256: 'a'.repeat(64) })) },
    tools: [{ id: 'esptool_py', package: '@aily-project/tool-esptool_py', version: '5.3.0' }],
    sdkAssets: resources.map(({ sdkPath, kind, ...item }) => ({ ...reference(item), sdkPath, kind })),
    boardOverrides: { uploadParam: null, linkUploadParam: null },
    upload: {
      toolName: 'esptool_py', use1200bpsTouch: false, waitForUploadPort: false,
      command: [
        wrapped ? '"__AILY_SDK__\\tools\\flasher.exe" --esptool ' + TOOL + ' --build-dir "__AILY_BUILD__"' : TOOL,
        '--chip esp32c3 --port "$' + '{serial}" --baud 921600  --before default-reset --after hard-reset',
        'write-flash  -z --flash-mode keep --flash-freq keep --flash-size keep',
        '0x0 "__AILY_BUILD__/sketch.bootloader.bin" 0x8000 "__AILY_BUILD__/sketch.partitions.bin"',
        ...(bootApp ? ['0xe000 "__AILY_SDK__/tools/partitions/boot_app0.bin"'] : []),
        '0x10000 "__AILY_BUILD__/sketch.bin"',
      ].join(' '),
    },
  };
  const flashPlan = {
    schemaVersion: 1, protocol: 'cloud-recipe', uploaderId: 'windows-sdk', targetChip: 'esp32c3',
    lifecycle: { reset: 'cloud-recipe', verify: true }, options: {}, segments: firmware.map(reference), recipe,
  };
  const artifacts = [...firmware, ...resources.map(({ sdkPath, kind, ...item }) => item)];
  validateCloudRecipePlan(flashPlan, artifacts);
  return { manifest: { artifacts, flashPlan }, recipe };
}

test('the signed LinkBit serial recipe generates bounded native esptool arguments', () => {
  const { manifest, recipe } = fixture();
  const plan = macEsp32SerialPlan(manifest, recipe);
  const root = path.resolve('staged cloud firmware');
  assert.deepEqual(plan, {
    chip: 'esp32c3', baudRate: 921600, before: 'default-reset', after: 'hard-reset',
    flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', segments: [
      { offset: 0, path: 'sketch.bootloader.bin' },
      { offset: 0x8000, path: 'sketch.partitions.bin' },
      { offset: 0xe000, path: 'upload-resources/' + BOOT_APP },
      { offset: 0x10000, path: 'sketch.bin' },
    ],
  });
  assert.deepEqual(macEsp32SerialArgs(plan, '/dev/cu.usbmodem1101', root), [
    '--chip', 'esp32c3', '--port', '/dev/cu.usbmodem1101', '--baud', '921600',
    '--before', 'default-reset', '--after', 'hard-reset', 'write-flash', '-z',
    '--flash-mode', 'keep', '--flash-freq', 'keep', '--flash-size', 'keep',
    '0x0', path.join(root, 'sketch.bootloader.bin'),
    '0x8000', path.join(root, 'sketch.partitions.bin'),
    '0xe000', path.join(root, 'upload-resources', ...BOOT_APP.split('/')),
    '0x10000', path.join(root, 'sketch.bin'),
  ]);
});

test('accepts the canonical direct esptool recipe with three signed firmware files', () => {
  const { manifest, recipe } = fixture({ wrapped: false, bootApp: false });
  assert.equal(macEsp32SerialPlan(manifest, recipe).segments.length, 3);
});

test('accepts the signed Seeed XIAO board id with its ESP32-S3 esptool chip', () => {
  const { manifest, recipe } = fixture({ wrapped: false });
  recipe.fqbn = 'esp32:esp32:XIAO_ESP32S3:FlashSize=8M,UploadSpeed=921600';
  recipe.upload.command = recipe.upload.command.replace('--chip esp32c3', '--chip esp32s3');
  manifest.flashPlan.targetChip = 'XIAO_ESP32S3';
  validateCloudRecipePlan(manifest.flashPlan, manifest.artifacts);
  const plan = macEsp32SerialPlan(manifest, recipe);
  assert.equal(plan.chip, 'esp32s3');
  assert.deepEqual(plan.segments.map(segment => segment.offset), [0, 0x8000, 0xe000, 0x10000]);
  recipe.upload.command = recipe.upload.command.replace('--chip esp32s3', '--chip esp32c3');
  assert.equal(macEsp32SerialPlan(manifest, recipe), null);
  recipe.upload.command = recipe.upload.command.replace('--chip esp32c3', '--chip esp32s3');
  manifest.flashPlan.targetChip = 'esp32s3';
  assert.equal(macEsp32SerialPlan(manifest, recipe), null);
});

test('checks the reviewed bootloader address for the selected chip', () => {
  const { manifest, recipe } = fixture();
  manifest.flashPlan.targetChip = 'esp32';
  recipe.fqbn = recipe.fqbn.replaceAll('esp32c3', 'esp32');
  recipe.upload.command = recipe.upload.command.replace('--chip esp32c3', '--chip esp32');
  assert.equal(macEsp32SerialPlan(manifest, recipe), null);
  recipe.upload.command = recipe.upload.command.replace('0x0 ', '0x1000 ');
  assert.equal(macEsp32SerialPlan(manifest, recipe).segments[0].offset, 0x1000);
});

for (const [description, change] of [
  ['a board override', ({ recipe }) => { recipe.boardOverrides.uploadParam = 'custom'; }],
  ['a custom upload lifecycle', ({ recipe }) => { recipe.upload.waitForUploadPort = true; }],
  ['the legacy esptool syntax', ({ recipe }) => { recipe.tools[0].version = '4.8.0'; }],
  ['an unknown esptool switch', ({ recipe }) => { recipe.upload.command = recipe.upload.command.replace('-z ', '-z --erase-all '); }],
  ['an arbitrary executable', ({ recipe }) => { recipe.upload.command = recipe.upload.command.replace('flasher.exe', 'other.exe'); }],
  ['an invalid partition address', ({ recipe }) => { recipe.upload.command = recipe.upload.command.replace('0x8000 ', '0x1000 '); }],
  ['overlapping signed firmware', ({ manifest }) => { manifest.artifacts[1].sizeBytes = 0xa000; }],
  ['an unsigned boot resource', ({ recipe }) => { recipe.sdkAssets.pop(); }],
  ['a mismatched firmware hash', ({ manifest }) => { manifest.flashPlan.segments[0].sha256 = 'f'.repeat(64); }],
  ['the wrong expected chip', ({ manifest }) => { manifest.flashPlan.targetChip = 'esp32s3'; }],
  ['a path outside the staged data', ({ recipe }) => { recipe.upload.command = recipe.upload.command.replace('/sketch.bin', '/../sketch.bin'); }],
  ['a command suffix', ({ recipe }) => { recipe.upload.command += ' && echo unexpected'; }],
]) test('does not adapt ' + description, () => {
  const data = fixture();
  change(data);
  assert.equal(macEsp32SerialPlan(data.manifest, data.recipe), null);
});

test('rejects any serial-port token outside of the macOS device namespace', () => {
  const { manifest, recipe } = fixture();
  const plan = macEsp32SerialPlan(manifest, recipe);
  for (const port of ['COM3', '/dev/../tty.usbmodem', '/dev/cu.usbmodem;option', '--help', '/dev/cu.usbmodem\n']) {
    assert.throws(() => macEsp32SerialArgs(plan, port, path.resolve('stage')), { code: 'UPLOAD_INVALID' });
  }
});
