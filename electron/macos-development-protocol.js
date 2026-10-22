const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { createDevelopmentProtocolArgs, getProductAuthConfig } = require('./build-product');
const execute = promisify(execFile);

// A dedicated app identity keeps URL delivery independent of generic Electron.app copies.
async function registerMacDevelopmentProtocol({ cacheRoot, executable, appEntry, product, serve }) {
  const auth = getProductAuthConfig(product);
  const entry = await fs.realpath(appEntry);
  const binary = await fs.realpath(executable);
  const source = path.join(__dirname, 'native/macos-protocol-relay.m');
  const args = createDevelopmentProtocolArgs({ appEntry: entry, product: auth.product, serve });
  const identity = createHash('sha256').update(JSON.stringify({ entry, binary, args })).digest('hex').slice(0, 16);
  const bundleId = `pro.aily.${auth.product}.development.${identity}`;
  const bundle = path.join(cacheRoot, identity, 'Aily Development Callback.app');
  const contents = path.join(bundle, 'Contents');
  const receiver = path.join(contents, 'MacOS/AilyProtocolRelay');
  const stamp = path.join(contents, 'Resources/fingerprint');

  const configuration = {
    CFBundleIdentifier: bundleId,
    CFBundleName: `Aily ${auth.product} Development Callback`,
    CFBundleExecutable: 'AilyProtocolRelay',
    CFBundlePackageType: 'APPL',
    CFBundleVersion: '1',
    LSUIElement: true,
    CFBundleURLTypes: [{ CFBundleURLName: bundleId, CFBundleURLSchemes: auth.protocols }],
    AilyElectronExecutable: binary,
    AilyElectronArguments: args,
    AilyWorkingDirectory: path.dirname(entry),
  };

  const fingerprint = createHash('sha256').update(await fs.readFile(source))
    .update(JSON.stringify(configuration)).update(process.arch).digest('hex');

  const previous = await fs.readFile(stamp, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;

    throw error;
  });

  if (previous !== fingerprint || !await fs.stat(receiver).catch(() => null)) {
    await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
    await fs.mkdir(path.join(contents, 'Resources'), { recursive: true });

    const pending = `${receiver}.${process.pid}`;

    try {
      await execute('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-framework', 'AppKit',
        '-framework', 'CoreServices', source, '-o', pending]);

      await fs.rename(pending, receiver);
      await fs.writeFile(path.join(contents, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">${plist(configuration)}</plist>\n`);

      await fs.writeFile(stamp, fingerprint);
    } finally {
      await fs.rm(pending, { force: true });
    }
  }

  await execute(receiver, ['--register']);

  return { bundleId, bundle };
}

function plist(value) {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (Array.isArray(value)) return `<array>${value.map(plist).join('')}</array>`;

  if (value && typeof value === 'object') {
    return `<dict>${Object.entries(value).map(([key, child]) => `<key>${escapeXml(key)}</key>${plist(child)}`).join('')}</dict>`;
  }

  return `<string>${escapeXml(value)}</string>`;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

module.exports = { registerMacDevelopmentProtocol };
