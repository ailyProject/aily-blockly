'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validateCloudRecipePlan } = require('../../electron/cloud-build/cloud-recipe-contract');
const {
  macAvrSerialPlan, macAvrSerialArgs, macCiSerialPlan, macCiSerialArgs
} = require('../../electron/cloud-build/cloud-native-serial-adapters');

const AVR_COMMAND = '"__AILY_TOOL_avrdude__/bin/avrdude" "-C__AILY_TOOL_avrdude__/etc/avrdude.conf" -v  -patmega328p -carduino "-P${serial}" -b115200 -D "-Uflash:w:__AILY_BUILD__/sketch.hex:i"';
const CI_COMMAND = '"__AILY_TOOL_citool-cli__/citool-cli.exe" flash --port "${serial}" "__AILY_BUILD__/sketch.bin"';

function fixture({ fqbn, sdk, sdkVersion, tool, version, command, file }) {
  const artifact = { artifactId: 'primary', path: file, sha256: 'a'.repeat(64), role: 'firmware', sizeBytes: 100 };
  const recipe = {
    schemaVersion: 1, hostPlatform: 'win32', hostArch: 'x64', fqbn,
    sdkIdentity: { package: `@aily-project/sdk-${sdk}`, version: sdkVersion,
      sourceFiles: ['boards.txt', 'platform.txt'].map(name => ({ path: name, sha256: 'b'.repeat(64) })) },
    boardOverrides: { uploadParam: null, linkUploadParam: null },
    tools: [{ id: tool, package: `@aily-project/tool-${tool}`, version }], sdkAssets: [],
    upload: { command, toolName: tool, use1200bpsTouch: false, waitForUploadPort: false },
  };
  const { artifactId, sha256 } = artifact;
  const manifest = { artifacts: [artifact], flashPlan: { recipe, schemaVersion: 1, profileDigest: 'c'.repeat(64),
    protocol: 'cloud-recipe', uploaderId: 'windows-sdk', targetChip: fqbn.split(':')[2], options: {},
    lifecycle: { reset: 'cloud-recipe', verify: true }, segments: [{ artifactId, sha256, path: file }] } };
  return { recipe, manifest };
}

function avr(fqbn = 'arduino:avr:uno', command = AVR_COMMAND) {
  return fixture({ fqbn, sdk: 'avr', sdkVersion: '1.8.6', tool: 'avrdude', version: '6.3.0', command, file: 'sketch.hex' });
}

function ci(fqbn = 'chipintelli:ci13xx:ci1306:Algorithm=aec,Clock=external', command = CI_COMMAND, file = 'sketch.bin') {
  return fixture({ fqbn, sdk: 'ci13xx', sdkVersion: '1.0.18', tool: 'citool-cli', version: '1.2.2', command, file });
}

test('AVR uses local avrdude arguments while preserving signed chip, programmer and baud rate', () => {
  const { manifest, recipe } = avr();
  assert.doesNotThrow(() => validateCloudRecipePlan(manifest.flashPlan, manifest.artifacts));
  const plan = macAvrSerialPlan(manifest, recipe);
  assert.deepEqual(plan, { firmware: 'sketch.hex', chip: 'atmega328p', programmer: 'arduino', baudRate: 115200, verbose: true });
  const buildPath = path.join('tmp with spaces', 'build');
  const tools = path.join('verified tools', 'avrdude');
  assert.deepEqual(macAvrSerialArgs(plan, '/dev/cu.usbmodem1101', buildPath, tools), [
    '-C', path.join(tools, 'etc', 'avrdude.conf'), '-v', '-p', 'atmega328p', '-c', 'arduino', '-P', '/dev/cu.usbmodem1101',
    '-b', '115200', '-D', '-U', `flash:w:${path.join(buildPath, 'sketch.hex')}:i`,
  ]);
});

test('AVR retains SDK-resolved Nano and Mega menu settings', () => {
  const cases = [
    ['arduino:avr:nano:cpu=atmega328old', AVR_COMMAND.replace('115200', '57600'), 'atmega328p', 'arduino', 57600],
    ['arduino:avr:mega:cpu=atmega2560', AVR_COMMAND.replace('atmega328p', 'atmega2560').replace('-carduino', '-cwiring'), 'atmega2560', 'wiring', 115200],
  ];
  for (const [fqbn, command, chip, programmer, baudRate] of cases) {
    const { manifest, recipe } = avr(fqbn, command);
    assert.deepEqual(macAvrSerialPlan(manifest, recipe), { firmware: 'sketch.hex', chip, programmer, baudRate, verbose: true });
  }
});

test('AVR rejects unsupported flags, device placeholders and firmware operands', () => {
  for (const command of [
    AVR_COMMAND.replace('-D', '-D -V'), AVR_COMMAND.replace('-D', '-e'), AVR_COMMAND.replace('-carduino', '-cusbasp'),
    AVR_COMMAND.replace('${serial}', 'COM1'), AVR_COMMAND.replace('sketch.hex', 'unsigned.hex'),
    AVR_COMMAND.replace('sketch.hex', '../sketch.hex'), AVR_COMMAND.replace(':i"', ':r"'),
    AVR_COMMAND + ' "-Ueeprom:w:__AILY_BUILD__/sketch.eep:i"',
  ]) {
    const { manifest, recipe } = avr(undefined, command);
    assert.equal(macAvrSerialPlan(manifest, recipe), null);
  }
  const { manifest, recipe } = avr();
  recipe.upload.use1200bpsTouch = true;
  assert.equal(macAvrSerialPlan(manifest, recipe), null);
});

test('CI13xx uses the signed primary full image and local citool UART command', () => {
  for (const target of ['ci1302', 'ci1303', 'ci1306', 'easyvoice_1306_dev']) {
    const { manifest, recipe } = ci(`chipintelli:ci13xx:${target}`);
    assert.doesNotThrow(() => validateCloudRecipePlan(manifest.flashPlan, manifest.artifacts));
    const plan = macCiSerialPlan(manifest, recipe);
    assert.deepEqual(plan, { firmware: 'sketch.bin' });
    assert.deepEqual(macCiSerialArgs(plan, '/dev/tty.usbserial-CI', 'build dir'), [
      'flash', '--port', '/dev/tty.usbserial-CI', path.join('build dir', 'sketch.bin'),
    ]);
  }
});

test('CI13xx rejects extra options, user code images and overridden SDK recipes', () => {
  for (const [command, file] of [
    [CI_COMMAND + ' --no-reset', 'sketch.bin'],
    [CI_COMMAND.replace('sketch.bin', 'sketch.user_code.bin'), 'sketch.user_code.bin'],
    [CI_COMMAND.replace('sketch.bin', 'unsigned.bin'), 'sketch.bin'],
  ]) {
    const { manifest, recipe } = ci(undefined, command, file);
    assert.equal(macCiSerialPlan(manifest, recipe), null);
  }
  const { manifest, recipe } = ci();
  recipe.boardOverrides.uploadParam = 'custom upload command';
  assert.equal(macCiSerialPlan(manifest, recipe), null);
});

test('native AVR and CI13xx reject an invalid macOS physical port', () => {
  for (const port of ['COM1', '/dev/tty', '/dev/cu../tty', '/tmp/cu.usbmodem', '/dev/cu.port --foo', '/dev/cu.usbmodem\n']) {
    assert.throws(() => macAvrSerialArgs({}, port, 'build', 'tools'), { code: 'UPLOAD_INVALID' });
    assert.throws(() => macCiSerialArgs({}, port, 'build'), { code: 'UPLOAD_INVALID' });
  }
});
