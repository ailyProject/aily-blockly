'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function shouldIgnoreSshHostKey(request) {
  return request?.transport === 'ssh'
    && request.endpoint?.hostKeyPolicy === 'accept-any';
}

function prepareConnectorRequest(request) {
  if (!shouldIgnoreSshHostKey(request)) return request;
  const credentials = request.credentials && typeof request.credentials === 'object'
    ? { ...request.credentials }
    : undefined;
  if (credentials) delete credentials.hostKey;
  return {
    ...request,
    endpoint: {
      ...request.endpoint,
      // Current connector releases implement automatic acceptance through
      // TOFU, so remove the saved key around every connection attempt.
      hostKeyPolicy: 'trust-on-first-use',
    },
    ...(credentials ? { credentials } : {}),
  };
}

async function forgetKnownSshHost(endpoint, options = {}) {
  const dataPath = path.resolve(
    options.dataPath
      || process.env.AILY_CONNECTOR_DATA_PATH
      || path.join(os.homedir(), '.aily-connector'),
  );
  const knownHostsPath = path.join(dataPath, 'ssh-known-hosts.json');
  const hostId = `${endpoint.host}:${endpoint.port ?? 22}`;
  let entries;
  try {
    entries = JSON.parse(await fs.promises.readFile(knownHostsPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error instanceof SyntaxError) {
      await fs.promises.rm(knownHostsPath, { force: true });
      return;
    }
    throw error;
  }

  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    await fs.promises.rm(knownHostsPath, { force: true });
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(entries, hostId)) return;
  delete entries[hostId];
  if (Object.keys(entries).length === 0) {
    await fs.promises.rm(knownHostsPath, { force: true });
    return;
  }

  const temporary = `${knownHostsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      await fs.promises.rename(temporary, knownHostsPath);
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EEXIST') throw error;
      await fs.promises.rm(knownHostsPath, { force: true });
      await fs.promises.rename(temporary, knownHostsPath);
    }
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

module.exports = {
  forgetKnownSshHost,
  prepareConnectorRequest,
  shouldIgnoreSshHostKey,
};
