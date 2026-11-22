'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { rootAttachment, storageExecutor } = require('../../../electron/project-file-lock-owner');

const [, , project, cut] = process.argv;
const directory = path.join(project, '.aily');
const marker = path.join(directory, 'project-files.write.lock');
const token = randomUUID();
const staged = path.join(directory, `.project-files.write.lock.${token}.tmp`);
const { processIdentity, bootId, instanceId } = storageExecutor();
const descriptor = fs.openSync(staged, 'wx', 0o600);
fs.writeFileSync(descriptor, JSON.stringify({
  version: 2, pid: process.pid, token, publication: 'exclusive-link-v1',
  processIdentity, bootId, instanceId, producer: 'lex', workspace: { attachment: rootAttachment(project) },
}));
fs.fsyncSync(descriptor);
fs.linkSync(staged, marker);
if (cut === 'canonical-only') fs.unlinkSync(staged);
process.send({ pid: process.pid, token });
process.once('message', () => {
  fs.closeSync(descriptor);
  process.disconnect();
});
