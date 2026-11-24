'use strict';

const path = require('node:path');
const protocol = require('./protocol');

const AVR_PROGRAMMERS = {
  arduino: new Set(['atmega8', 'atmega168', 'atmega328', 'atmega328p', 'atmega1280']),
  wiring: new Set(['atmega1280', 'atmega2560']),
};
const CI_TARGETS = new Set(['ci1302', 'ci1303', 'ci1306', 'ci_d06gt01d', 'easyvoice_1306_dev']);

function sdkSerialUpload(recipe, tool, toolVersion, sdk, sdkVersions) {
  const upload = recipe.upload;
  return recipe.sdkIdentity.package === `@aily-project/sdk-${sdk}`
    && sdkVersions.includes(recipe.sdkIdentity.version)
    && (recipe.boardOverrides.uploadParam == null || recipe.boardOverrides.uploadParam === '')
    && recipe.tools.length === 1 && recipe.tools[0].id === tool
    && recipe.tools[0].package === `@aily-project/tool-${tool}` && recipe.tools[0].version === toolVersion
    && recipe.sdkAssets.length === 0 && upload?.toolName === tool
    && upload.use1200bpsTouch === false && upload.waitForUploadPort === false;
}

function signedPrimaryFirmware(manifest, filename) {
  const primary = manifest.flashPlan.segments[0];
  return primary?.path === filename && manifest.artifacts.some(artifact => artifact.path === filename
    && artifact.artifactId === primary.artifactId && artifact.sha256 === primary.sha256
    && artifact.role === 'firmware' && artifact.sizeBytes > 0);
}

function validateMacSerialPort(serialPort) {
  if (typeof serialPort !== 'string' || !/^\/dev\/(?:cu|tty)\.[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(serialPort)) {
    throw protocol.error('UPLOAD_INVALID', 'Select a physical macOS serial port before uploading.');
  }
}

// Read the reviewed SDK command forms as data after signature and board validation.
// Only the typed settings below are used to construct a local argv.
function macAvrSerialPlan(manifest, recipe) {
  if (!sdkSerialUpload(recipe, 'avrdude', '6.3.0', 'avr', ['1.8.6', '1.8.7'])
    || !recipe.fqbn.startsWith('arduino:avr:')) return null;

  const [executable, config, ...options] = recipe.upload.command.trim().split(/ +/u);
  if (!/^"__AILY_TOOL_avrdude__[\\/](?:bin[\\/])?avrdude(?:\.exe)?"$/u.test(executable)
    || !/^"-C__AILY_TOOL_avrdude__[\\/]etc[\\/]avrdude\.conf"$/u.test(config)) return null;

  const verbose = options[0] === '-v';
  const [chipArg, programmerArg, port, baudArg, noErase, image, ...extra] = verbose ? options.slice(1) : options;
  const chip = chipArg?.match(/^-p([a-z0-9]+)$/u)?.[1];
  const programmer = programmerArg?.match(/^-c(arduino|wiring)$/u)?.[1];
  const baudRate = Number(baudArg?.match(/^-b([1-9]\d{3,6})$/u)?.[1]);
  const firmware = image?.match(/^"-Uflash:w:__AILY_BUILD__[\\/]([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\.hex):i"$/u)?.[1];
  if (extra.length || !AVR_PROGRAMMERS[programmer]?.has(chip)
    || port !== '"-P${serial}"' || !(baudRate >= 1200 && baudRate <= 2000000) || noErase !== '-D'
    || !firmware || firmware.endsWith('.with_bootloader.hex') || !signedPrimaryFirmware(manifest, firmware)) return null;
  return { firmware, chip, programmer, baudRate, verbose };
}

function macCiSerialPlan(manifest, recipe) {
  const [vendor, architecture, target] = recipe.fqbn.split(':');
  if (vendor !== 'chipintelli' || architecture !== 'ci13xx' || !CI_TARGETS.has(target)
    || !sdkSerialUpload(recipe, 'citool-cli', '1.2.2', 'ci13xx', ['1.0.14', '1.0.15', '1.0.17', '1.0.18'])) return null;

  const [executable, operation, portFlag, port, image, ...extra] = recipe.upload.command.trim().split(/ +/u);
  const firmware = image?.match(/^"__AILY_BUILD__[\\/]([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\.bin)"$/u)?.[1];
  if (extra.length || !/^"__AILY_TOOL_citool-cli__[\\/]citool-cli\.exe"$/u.test(executable)
    || operation !== 'flash' || portFlag !== '--port' || port !== '"${serial}"'
    || !firmware || firmware.endsWith('.user_code.bin') || !signedPrimaryFirmware(manifest, firmware)) return null;
  return { firmware };
}

function macAvrSerialArgs(plan, serialPort, buildPath, toolDirectory) {
  validateMacSerialPort(serialPort);
  return ['-C', path.join(toolDirectory, 'etc', 'avrdude.conf'), ...(plan.verbose ? ['-v'] : []),
    '-p', plan.chip, '-c', plan.programmer, '-P', serialPort, '-b', String(plan.baudRate), '-D',
    '-U', `flash:w:${path.join(buildPath, plan.firmware)}:i`];
}

function macCiSerialArgs(plan, serialPort, buildPath) {
  validateMacSerialPort(serialPort);
  return ['flash', '--port', serialPort, path.join(buildPath, plan.firmware)];
}

module.exports = { macAvrSerialPlan, macCiSerialPlan, macAvrSerialArgs, macCiSerialArgs };
