'use strict';
const path = require('node:path');
const protocol = require('./protocol');

const ESPTOOL = '"__AILY_TOOL_esptool_py__/esptool.exe"';
const WRAPPER = '"__AILY_SDK__/tools/flasher.exe"';
const WRAPPED_ESPTOOL = WRAPPER + ' --esptool ' + ESPTOOL + ' --build-dir "__AILY_BUILD__"';
const BOOT_APP_SDK_PATH = 'tools/partitions/boot_app0.bin';
const BOOTLOADER_OFFSETS = new Map([
  ['esp32', 0x1000], ['esp32s2', 0x1000], ['esp32s3', 0], ['esp32c3', 0], ['esp32c6', 0],
]);
const SERIAL_OPTIONS = new RegExp([
  '^--chip (?<chip>[a-z0-9]+) --port "\\$\\{serial\\}" --baud (?<baudRate>[0-9]{4,7})',
  '--before (?<before>[a-z-]+) --after (?<after>[a-z-]+) write-flash -z',
  '--flash-mode (?<flashMode>[a-z]+) --flash-freq (?<flashFreq>[a-z0-9]+)',
  '--flash-size (?<flashSize>[a-zA-Z0-9]+) (?<files>.+)$',
].join(' '), 'u');

function matchingArtifact(manifest, reference, file, role) {
  if (!reference || reference.path !== file) return null;
  return manifest.artifacts.find(artifact => artifact.path === file && artifact.role === role
    && artifact.artifactId === reference.artifactId && artifact.sha256 === reference.sha256
    && Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes > 0) || null;
}

function flashSegments(manifest, recipe, options, wrapped) {
  const references = manifest.flashPlan.segments;
  const app = references[0];
  const sketchName = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\.bin$/u.exec(app?.path)?.[1];
  if (!sketchName || references.length !== 3) return null;

  const bootApp = recipe.sdkAssets.find(asset => asset.sdkPath === BOOT_APP_SDK_PATH && asset.kind === 'static');
  const wrapper = recipe.sdkAssets.find(asset => asset.sdkPath === 'tools/flasher.exe' && asset.kind === 'executable');
  if (recipe.sdkAssets.length !== Number(wrapped) + Number(Boolean(bootApp))
      || (wrapped && !matchingArtifact(manifest, wrapper, 'upload-resources/tools/flasher.exe', 'upload-resource'))) return null;

  const expected = [
    { offset: BOOTLOADER_OFFSETS.get(options.chip), file: sketchName + '.bootloader.bin', role: 'auxiliary' },
    { offset: 0x8000, file: sketchName + '.partitions.bin', role: 'auxiliary' },
    ...(bootApp ? [{ offset: 0xe000, file: 'upload-resources/' + BOOT_APP_SDK_PATH, role: 'upload-resource' }] : []),
    { offset: 0x10000, file: app.path, role: 'firmware' },
  ];
  const words = options.files.split(' ');
  if (words.length !== expected.length * 2) return null;
  const result = [];
  let end = 0;
  for (const [index, { offset, file, role }] of expected.entries()) {
    const operand = role === 'upload-resource' ? '"__AILY_SDK__/' + BOOT_APP_SDK_PATH + '"' : '"__AILY_BUILD__/' + file + '"';
    const reference = role === 'upload-resource' ? bootApp : references.find(segment => segment.path === file);
    const artifact = matchingArtifact(manifest, reference, file, role);
    const address = words[index * 2];
    if (!/^0x[0-9a-f]{1,8}$/iu.test(address) || Number(address) !== offset || words[index * 2 + 1] !== operand
        || !artifact || offset < end || offset + artifact.sizeBytes > 0x100000000) return null;
    end = offset + artifact.sizeBytes;
    result.push({ offset, path: file });
  }
  return result;
}

// The caller verifies the signed cloud contract and installed board identity
// first. Read only this reviewed ESP32 serial grammar as structured input.
function macEsp32SerialPlan(manifest, recipe) {
  const tool = recipe.tools[0];
  const upload = recipe.upload;
  if (recipe.hostPlatform !== 'win32' || recipe.hostArch !== 'x64'
      || recipe.sdkIdentity.package !== '@aily-project/sdk-esp32'
      || recipe.tools.length !== 1 || tool.id !== 'esptool_py' || tool.package !== '@aily-project/tool-esptool_py'
      || !/^5\.\d+\.\d+$/u.test(tool.version)
      || recipe.boardOverrides.uploadParam != null || recipe.boardOverrides.linkUploadParam != null
      || !upload || upload.toolName !== 'esptool_py' || upload.use1200bpsTouch || upload.waitForUploadPort) return null;

  const command = upload.command.trim().replace(/\\/gu, '/').replace(/[ \t]+/gu, ' ');
  const wrapped = command.startsWith(WRAPPED_ESPTOOL + ' ');
  const prefix = wrapped ? WRAPPED_ESPTOOL : ESPTOOL;
  if (!command.startsWith(prefix + ' ')) return null;
  const options = SERIAL_OPTIONS.exec(command.slice(prefix.length + 1))?.groups;
  if (!options) return null;
  const { chip, before, after, flashMode, flashFreq, flashSize } = options;
  const baudRate = Number(options.baudRate);
  if (!BOOTLOADER_OFFSETS.has(chip) || manifest.flashPlan.targetChip !== chip
      || recipe.fqbn.split(':').slice(0, 3).join(':') !== 'esp32:esp32:' + chip
      || baudRate < 1200 || baudRate > 2000000
      || !['default-reset', 'no-reset', 'usb-reset'].includes(before)
      || !['hard-reset', 'soft-reset', 'no-reset'].includes(after)
      || !['keep', 'qio', 'qout', 'dio', 'dout'].includes(flashMode)
      || !['keep', '20m', '26m', '40m', '80m'].includes(flashFreq)
      || !['keep', 'detect', '1MB', '2MB', '4MB', '8MB', '16MB', '32MB'].includes(flashSize)) return null;

  const segments = flashSegments(manifest, recipe, options, wrapped);
  return segments ? { chip, baudRate, before, after, flashMode, flashFreq, flashSize, segments } : null;
}

function macEsp32SerialArgs(plan, serialPort, buildPath) {
  if (typeof serialPort !== 'string' || !/^\/dev\/(?:cu|tty)\.[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(serialPort)) {
    throw protocol.error('UPLOAD_INVALID', 'Select a physical macOS serial port.');
  }
  return [
    '--chip', plan.chip, '--port', serialPort, '--baud', String(plan.baudRate),
    '--before', plan.before, '--after', plan.after, 'write-flash', '-z',
    '--flash-mode', plan.flashMode, '--flash-freq', plan.flashFreq, '--flash-size', plan.flashSize,
    ...plan.segments.flatMap(segment => ['0x' + segment.offset.toString(16), path.join(buildPath, ...segment.path.split('/'))]),
  ];
}

module.exports = { macEsp32SerialPlan, macEsp32SerialArgs };
