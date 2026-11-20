'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fault } = require('./subapp-download');

const CHAT_ID = 'aily-chat';
const CHAT_PACKAGE = '@aily-project/subapp-aily-chat';
const RECEIPT = 'runtime/build-evidence.json';
const PRODUCT_PATHS = ['package.json', 'server', 'runtime', 'ui', 'i18n', 'vendor'];
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');

function supportsBlocklyAbs(compatibility) {
  const abs = compatibility?.blocklyAbs;
  return compatibility?.version === 1 && abs?.generation === 2 && abs.absSchema === 2
    && abs.workingCandidateVersion === 1 && abs.legacyDraftTakeover === 1
    && Array.isArray(abs.publicMapSchemas) && [1, 2].every(schema => abs.publicMapSchemas.includes(schema));
}

async function verifyBlocklyChatArtifact(packagePath, entries) {
  const plainFile = async relative => {
    const filename = path.join(packagePath, relative);
    if (!(await fs.lstat(filename)).isFile()) throw new Error('Expected a plain Chat artifact file');
    return fs.readFile(filename);
  };
  try {
    const manifest = JSON.parse(await plainFile('package.json'));
    if (manifest.name !== CHAT_PACKAGE || manifest.ailyPortable?.format !== 'js'
      || manifest.ailyPortable.version !== 1 || !supportsBlocklyAbs(manifest.ailySubapp?.compatibility)) return null;

    const receipt = JSON.parse(await plainFile(RECEIPT));
    if (receipt.version !== 1 || !isHash(receipt.inputHash) || !isHash(receipt.outputHash)
      || receipt.inputHash !== digest(JSON.stringify(receipt.inputs))
      || receipt.outputHash !== digest(JSON.stringify(receipt.outputs))) return null;
    if (entries.some(entry => typeof entry !== 'string'
      || !isHash(receipt.outputs[entry.replace(/\\/g, '/').replace(/^\.\//, '')]))) return null;

    const files = [];
    async function visit(relative) {
      const file = await fs.lstat(path.join(packagePath, relative));
      if (file.isDirectory()) {
        const children = await fs.readdir(path.join(packagePath, relative));
        await Promise.all(children.map(child => visit(`${relative}/${child}`)));
      } else if (file.isFile()) {
        if (relative !== RECEIPT) files.push(relative);
      } else throw new Error('Chat artifact contains a nonregular file');
    }
    // Keep the same output inventory as Chat's portable runtime verifier. The
    // host verifies the bytes before executing the selected package at all.
    await Promise.all(PRODUCT_PATHS.map(visit));
    if (files.length !== Object.keys(receipt.outputs).length) return null;
    let cursor = 0;
    const verified = await Promise.all(Array.from({ length: Math.min(files.length, 16) }, async () => {
      while (cursor < files.length) {
        const relative = files[cursor++];
        if (!isHash(receipt.outputs[relative]) || digest(await plainFile(relative)) !== receipt.outputs[relative]) {
          return false;
        }
      }
      return true;
    }));
    return verified.every(Boolean) ? { inputHash: receipt.inputHash, outputHash: receipt.outputHash } : null;
  } catch {
    return null;
  }
}

async function verifyBlocklyChatRuntime(url, expected, fetchImpl = globalThis.fetch) {
  if (!isHash(expected?.inputHash) || !isHash(expected?.outputHash)) return false;
  try {
    const origin = new URL(url);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port
      || origin.username || origin.password) return false;
    const response = await fetchImpl(new URL('/health', origin), {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const health = await response.json();
    const build = health?.buildEvidence;
    return health?.ok === true && health?.state === 'ready' && supportsBlocklyAbs(health.compatibility)
      && build?.version === 1 && build.inputHash === expected.inputHash && build.outputHash === expected.outputHash;
  } catch {
    return false;
  }
}

function chatCompatibilityError() {
  return fault('BLOCKLY_CHAT_INCOMPATIBLE', 'A compatible Chat package is currently unavailable for this Blockly installation.');
}

module.exports = { CHAT_ID, CHAT_PACKAGE, chatCompatibilityError, supportsBlocklyAbs,
  verifyBlocklyChatArtifact, verifyBlocklyChatRuntime };
