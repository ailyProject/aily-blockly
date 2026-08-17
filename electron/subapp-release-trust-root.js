const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeSubappReleaseTrustPolicies,
} = require('./subapp-release-trust');

const SUBAPP_RELEASE_TRUST_ROOT_FILENAME = 'subapp-release-trust-root.json';
const MAX_SUBAPP_RELEASE_TRUST_ROOT_BYTES = 256 * 1024;

class SubappReleaseTrustRootError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SubappReleaseTrustRootError';
    this.code = 'SUBAPP_RELEASE_TRUST_ROOT_FAILED';
  }
}

function resolveBundledSubappReleaseTrustRootPath(moduleDirectory = __dirname) {
  if (typeof moduleDirectory !== 'string' || !path.isAbsolute(moduleDirectory)) {
    throw new SubappReleaseTrustRootError(
      'The bundled Subapp release trust root directory must be absolute.',
    );
  }
  return path.join(
    path.resolve(moduleDirectory),
    'resources',
    SUBAPP_RELEASE_TRUST_ROOT_FILENAME,
  );
}

function loadBundledSubappReleaseTrustRoot(options = {}) {
  const filePath = options.filePath === undefined
    ? resolveBundledSubappReleaseTrustRootPath(
      options.moduleDirectory === undefined ? __dirname : options.moduleDirectory,
    )
    : options.filePath;
  return loadSubappReleaseTrustRoot(filePath);
}

function loadSubappReleaseTrustRoot(filePath) {
  try {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new Error('Trust root path must be absolute');
    }
    const metadata = fs.lstatSync(filePath);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.size <= 0
      || metadata.size > MAX_SUBAPP_RELEASE_TRUST_ROOT_BYTES
    ) {
      throw new Error('Trust root must be a bounded regular file');
    }
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    requireExactTrustRootFields(value);
    if (
      value.schemaVersion !== 1
      || value.kind !== 'aily-subapp-release-trust-root'
    ) {
      throw new Error('Unsupported Subapp release trust root schema');
    }
    return Object.freeze({
      schemaVersion: 1,
      kind: value.kind,
      policies: normalizeSubappReleaseTrustPolicies(value.policies),
    });
  } catch (error) {
    if (error instanceof SubappReleaseTrustRootError) throw error;
    throw new SubappReleaseTrustRootError(
      'The host-bundled Subapp release trust root is invalid.',
      error,
    );
  }
}

function requireExactTrustRootFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Trust root must be an object');
  }
  const actual = Object.keys(value).sort();
  const expected = ['kind', 'policies', 'schemaVersion'];
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error('Trust root has an invalid field set');
  }
}

module.exports = {
  MAX_SUBAPP_RELEASE_TRUST_ROOT_BYTES,
  SUBAPP_RELEASE_TRUST_ROOT_FILENAME,
  SubappReleaseTrustRootError,
  loadBundledSubappReleaseTrustRoot,
  loadSubappReleaseTrustRoot,
  resolveBundledSubappReleaseTrustRootPath,
};
