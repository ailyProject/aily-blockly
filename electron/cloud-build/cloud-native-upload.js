'use strict';

const fs = require('node:fs');
const path = require('node:path');
const protocol = require('./protocol');
const { macEsp32SerialPlan, macEsp32SerialArgs } = require('./cloud-esp32-upload');
const {
  macAvrSerialPlan, macAvrSerialArgs, macCiSerialPlan, macCiSerialArgs,
} = require('./cloud-native-serial-adapters');

const serialAdapters = {
  esptool_py: { plan: macEsp32SerialPlan, args: macEsp32SerialArgs, executables: ['esptool', 'bin/esptool', 'esptool/esptool'] },
  avrdude: { plan: macAvrSerialPlan, args: macAvrSerialArgs, executables: ['bin/avrdude', 'avrdude'], config: 'etc/avrdude.conf' },
  'citool-cli': { plan: macCiSerialPlan, args: macCiSerialArgs, executables: ['citool-cli'] },
};

function selectMacCloudUpload(manifest, recipe, transport) {
  if (transport === 'network-ota' || transport === 'ble') {
    const primary = manifest.flashPlan.segments[0];
    const image = manifest.artifacts.find(item => item.artifactId === primary.artifactId);
    // The existing Aily ESP32 OTA routes consume a single application image.
    if (recipe.sdkIdentity.package === '@aily-project/sdk-esp32' && image?.role === 'firmware'
        && /(?:^|\/)[^/]+\.bin$/u.test(primary.path)
        && !/\.(?:merged|bootloader|partitions)\.bin$/iu.test(primary.path)) {
      return { transport };
    }
    return null;
  }
  if (transport !== 'serial' || recipe.tools.length !== 1) return null;
  const [tool] = recipe.tools;
  if (!Object.hasOwn(serialAdapters, tool.id)) return null;
  const plan = serialAdapters[tool.id].plan(manifest, recipe);
  if (!plan) return null;
  return { transport, serial: { plan, requirement: { kind: 'tool', name: tool.package, version: tool.version, id: tool.id } } };
}

function checkPhysicalFile(file, mode) {
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) {
    throw protocol.error('UNSAFE_PATH', 'Native uploader files must be physical files inside the installed tool directory.');
  }
  fs.accessSync(file, mode);
  return file;
}

function nativeSerialExecutable(directory, toolId) {
  const adapter = Object.hasOwn(serialAdapters, toolId) && serialAdapters[toolId];
  if (!adapter) throw protocol.error('UPLOAD_UNSUPPORTED', 'This serial uploader has no native adapter.');
  for (const relative of adapter.executables) {
    try {
      const executable = checkPhysicalFile(path.join(directory, relative), fs.constants.X_OK);
      if (adapter.config) checkPhysicalFile(path.join(directory, adapter.config), fs.constants.R_OK);
      return executable;
    } catch (error) {
      if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw protocol.error('UPLOADER_MISSING', `The installed ${toolId} package did not provide its native uploader and required files.`);
}

function nativeSerialInvocation(staged, serialPort, directory) {
  const { plan, requirement } = staged.nativeUpload.serial;
  const command = nativeSerialExecutable(directory, requirement.id);
  const args = serialAdapters[requirement.id].args(plan, serialPort, staged.buildPath, directory);
  return { command, args };
}

module.exports = { selectMacCloudUpload, nativeSerialExecutable, nativeSerialInvocation };
