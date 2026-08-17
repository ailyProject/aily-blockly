const {
  createHash,
  createPublicKey,
  verify,
} = require('node:crypto');
const fs = require('node:fs');
const { URL } = require('node:url');

const SUBAPP_RELEASE_SIGNATURE_CONTEXT = 'aily-subapp-release-statement:v1';
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const STABLE_SEMVER = /^\d+\.\d+\.\d+$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const MAX_TARBALL_BYTES = 2 * 1024 * 1024 * 1024;

class SubappReleaseTrustError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SubappReleaseTrustError';
    this.code = 'SUBAPP_RELEASE_TRUST_FAILED';
  }
}

function validateSubappDistribution(value) {
  try {
    const distribution = requireExactRecord(value, [
      'channel',
      'platform',
      'releaseSignature',
      'schemaVersion',
      'tarballIntegrity',
      'tarballUrl',
    ], 'Subapp distribution');
    if (distribution.schemaVersion !== 1) throw new Error('Unsupported schema version');
    requirePortableId(distribution.channel, 'Subapp release channel');
    requirePortableId(distribution.platform, 'Subapp release platform');
    requireHttpsUrl(distribution.tarballUrl, 'Subapp tarball URL');
    requireSha512Integrity(distribution.tarballIntegrity);
    validateSignatureEnvelope(distribution.releaseSignature);
    return deepFreeze(structuredClone(value));
  } catch (error) {
    throw trustError('The Subapp distribution declaration is invalid.', error);
  }
}

function normalizeSubappReleaseTrustPolicies(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 64) {
    throw trustError('Subapp release trust policies must be a bounded array.');
  }
  const identities = new Set();
  const policies = value.map((item) => {
    try {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('Policy is not an object');
      }
      if (
        item.schemaVersion !== 1
        || item.kind !== 'aily-subapp-release-trusted-inputs'
      ) {
        throw new Error('Unsupported trusted input schema');
      }
      requirePortableId(item.subappId, 'trusted Subapp id');
      requirePackageName(item.packageName);
      requirePortableId(item.platform, 'trusted platform');
      const registryOrigin = requireHttpsOrigin(item.registryOrigin, 'trusted registry origin');
      const subappIndexOrigin = requireHttpsOrigin(
        item.subappIndexOrigin,
        'trusted Subapp index origin',
      );
      const releasePublicKeys = validateEd25519PublicKeys(item.releasePublicKeys);
      const identity = `${subappIndexOrigin}\0${item.subappId}\0${item.packageName}`;
      if (identities.has(identity)) throw new Error('Duplicate trust policy');
      identities.add(identity);
      return deepFreeze({
        schemaVersion: 1,
        kind: item.kind,
        subappId: item.subappId,
        packageName: item.packageName,
        platform: item.platform,
        registryOrigin,
        subappIndexOrigin,
        releasePublicKeys,
      });
    } catch (error) {
      throw trustError('A Subapp release trust policy is invalid.', error);
    }
  });
  return Object.freeze(policies);
}

function requiresTrustedSubappDistribution(entry, indexUrl, policies) {
  return Boolean(findTrustPolicy(entry, indexUrl, policies));
}

async function verifyDownloadedSubappDistribution({
  entry,
  indexUrl,
  policies,
  tarballPath,
}) {
  try {
    const normalizedPolicies = normalizeSubappReleaseTrustPolicies(policies);
    const policy = findTrustPolicy(entry, indexUrl, normalizedPolicies);
    if (!entry.distribution) {
      if (policy) {
        throw new Error('The required signed distribution declaration is missing');
      }
      return Object.freeze({ required: false, verified: false });
    }
    if (!policy) throw new Error('No trusted release policy matches this distribution');
    const distribution = validateSubappDistribution(entry.distribution);
    if (distribution.platform !== policy.platform) {
      throw new Error('The distribution platform is not trusted');
    }
    const tarballUrl = requireHttpsUrl(distribution.tarballUrl, 'Subapp tarball URL');
    if (tarballUrl.origin !== policy.registryOrigin) {
      throw new Error('The distribution registry origin is not trusted');
    }
    const statement = verifyReleaseSignature(
      distribution.releaseSignature,
      policy.releasePublicKeys,
    );
    const expected = {
      channel: distribution.channel,
      packageName: entry.package,
      packageVersion: entry.version,
      platform: distribution.platform,
      registryOrigin: policy.registryOrigin,
      subappId: entry.id,
      subappIndexOrigin: policy.subappIndexOrigin,
      tarballIntegrity: distribution.tarballIntegrity,
      tarballUrl: distribution.tarballUrl,
    };
    for (const [name, expectedValue] of Object.entries(expected)) {
      if (statement[name] !== expectedValue) {
        throw new Error(`The signed release statement does not match ${name}`);
      }
    }
    const actualIntegrity = await sha512IntegrityFile(tarballPath);
    if (actualIntegrity !== distribution.tarballIntegrity) {
      throw new Error('The downloaded Subapp tarball integrity does not match');
    }
    return deepFreeze({
      required: true,
      verified: true,
      subappId: entry.id,
      packageName: entry.package,
      packageVersion: entry.version,
      platform: distribution.platform,
      signingKeyId: distribution.releaseSignature.keyId,
      tarballIntegrity: actualIntegrity,
      metadata: statement.metadata,
    });
  } catch (error) {
    if (error instanceof SubappReleaseTrustError) throw error;
    throw trustError('Subapp release verification failed.', error);
  }
}

function findTrustPolicy(entry, indexUrl, policies) {
  const normalizedPolicies = Array.isArray(policies)
    && Object.isFrozen(policies)
    ? policies
    : normalizeSubappReleaseTrustPolicies(policies);
  if (normalizedPolicies.length === 0) return null;
  const indexOrigin = requireHttpsUrl(indexUrl, 'Subapp index URL').origin;
  const matches = normalizedPolicies.filter((policy) => (
    policy.subappId === entry.id
    && policy.packageName === entry.package
    && policy.subappIndexOrigin === indexOrigin
  ));
  if (matches.length > 1) throw trustError('Multiple Subapp release trust policies match.');
  return matches[0] || null;
}

function verifyReleaseSignature(value, publicKeys) {
  const envelope = validateSignatureEnvelope(value);
  const publicKey = publicKeys[envelope.keyId];
  if (!publicKey) throw new Error('The release signature uses an untrusted key');
  const payload = decodeCanonicalBase64Url(envelope.payloadBase64Url, 'release payload');
  const signature = decodeCanonicalBase64Url(
    envelope.signatureBase64Url,
    'release signature',
  );
  if (signature.byteLength !== 64) throw new Error('Invalid Ed25519 signature length');
  const signingInput = Buffer.from(
    `${SUBAPP_RELEASE_SIGNATURE_CONTEXT}.${envelope.payloadBase64Url}`,
    'ascii',
  );
  if (!verify(null, signingInput, createPublicKey(publicKey), signature)) {
    throw new Error('The release signature is invalid');
  }
  let statement;
  try {
    statement = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    throw new Error('The signed release statement is not UTF-8 JSON');
  }
  return validateReleaseStatement(statement);
}

function validateReleaseStatement(value) {
  const statement = requireExactRecord(value, [
    'channel',
    'kind',
    'metadata',
    'packageName',
    'packageVersion',
    'platform',
    'registryOrigin',
    'schemaVersion',
    'subappId',
    'subappIndexOrigin',
    'tarballIntegrity',
    'tarballUrl',
  ], 'Subapp release statement');
  if (
    statement.schemaVersion !== 1
    || statement.kind !== 'aily-subapp-release-statement'
    || !STABLE_SEMVER.test(statement.packageVersion)
  ) {
    throw new Error('The Subapp release statement identity is invalid');
  }
  requirePortableId(statement.subappId, 'release Subapp id');
  requirePackageName(statement.packageName);
  requirePortableId(statement.platform, 'release platform');
  requirePortableId(statement.channel, 'release channel');
  const registryOrigin = requireHttpsOrigin(statement.registryOrigin, 'release registry origin');
  requireHttpsOrigin(statement.subappIndexOrigin, 'release Subapp index origin');
  if (requireHttpsUrl(statement.tarballUrl, 'release tarball URL').origin !== registryOrigin) {
    throw new Error('The release tarball URL does not match its registry origin');
  }
  requireSha512Integrity(statement.tarballIntegrity);
  validateMetadata(statement.metadata);
  return deepFreeze(structuredClone(value));
}

function validateSignatureEnvelope(value) {
  const envelope = requireExactRecord(value, [
    'algorithm',
    'keyId',
    'kind',
    'payloadBase64Url',
    'schemaVersion',
    'signatureBase64Url',
  ], 'Subapp release signature');
  if (
    envelope.schemaVersion !== 1
    || envelope.kind !== 'aily-subapp-release-signature'
    || envelope.algorithm !== 'Ed25519'
  ) {
    throw new Error('The Subapp release signature identity is invalid');
  }
  requirePortableId(envelope.keyId, 'release key id');
  decodeCanonicalBase64Url(envelope.payloadBase64Url, 'release payload');
  decodeCanonicalBase64Url(envelope.signatureBase64Url, 'release signature');
  return envelope;
}

function validateEd25519PublicKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Release public keys must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 16) {
    throw new Error('Release public keys must contain between 1 and 16 keys');
  }
  const result = {};
  for (const [keyId, value_] of entries) {
    requirePortableId(keyId, 'release public key id');
    if (typeof value_ !== 'string' || value_.length > 8192) {
      throw new Error('Release public key is invalid');
    }
    const key = createPublicKey(value_);
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      throw new Error('Release public keys must be Ed25519');
    }
    result[keyId] = value_;
  }
  return Object.freeze(result);
}

function validateMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Release metadata must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error('Release metadata is too large');
  for (const [name, metadataValue] of entries) {
    requirePortableId(name, 'release metadata name');
    if (typeof metadataValue !== 'string' || metadataValue.length > 2048) {
      throw new Error('Release metadata values must be bounded strings');
    }
  }
}

async function sha512IntegrityFile(filePath) {
  const metadata = await fs.promises.lstat(filePath).catch(() => null);
  if (
    !metadata?.isFile()
    || metadata.isSymbolicLink()
    || metadata.size <= 0
    || metadata.size > MAX_TARBALL_BYTES
  ) {
    throw new Error('The downloaded Subapp tarball must be a bounded regular file');
  }
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return `sha512-${hash.digest('base64')}`;
}

function requireExactRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has an invalid field set`);
  }
  return value;
}

function requirePortableId(value, label) {
  if (typeof value !== 'string' || !PORTABLE_ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requirePackageName(value) {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) {
    throw new Error('Subapp package name is invalid');
  }
  return value;
}

function requireHttpsOrigin(value, label) {
  const url = requireHttpsUrl(value, label);
  if (url.href !== `${url.origin}/`) throw new Error(`${label} must not contain a path`);
  return url.origin;
}

function requireHttpsUrl(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error(`${label} is invalid`);
  }
  const url = new URL(value);
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return url;
}

function requireSha512Integrity(value) {
  if (typeof value !== 'string' || !SHA512_INTEGRITY.test(value)) {
    throw new Error('Subapp tarball SHA-512 integrity is invalid');
  }
}

function decodeCanonicalBase64Url(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is invalid`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error(`${label} is not canonical base64url`);
  }
  return decoded;
}

function trustError(message, cause) {
  return cause instanceof SubappReleaseTrustError
    ? cause
    : new SubappReleaseTrustError(message, cause);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

module.exports = {
  SUBAPP_RELEASE_SIGNATURE_CONTEXT,
  SubappReleaseTrustError,
  normalizeSubappReleaseTrustPolicies,
  requiresTrustedSubappDistribution,
  validateSubappDistribution,
  verifyDownloadedSubappDistribution,
};
