'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { tryAcquireFileLock } = require('../../../child/scripts/native-file-lock');

// Both historical writers held this descriptor from O_EXCL until publication
// ended. The older one had no separate native project guard.
const [, , project, mode] = process.argv;
const directory = path.join(project, '.aily');
fs.mkdirSync(directory, { recursive: true });
const guard = mode === 'guarded' ? tryAcquireFileLock(path.join(directory, 'project-files.guard')) : undefined;
if (mode === 'guarded' && !guard) throw new Error('Legacy guard could not be acquired');
const marker = path.join(directory, 'project-files.write.lock');
const descriptor = fs.openSync(marker, 'wx', 0o600);
process.send({ pid: process.pid, cut: 'before-owner-bytes' });
process.once('message', () => {
  fs.closeSync(descriptor);
  fs.unlinkSync(marker);
  guard?.close();
  process.disconnect();
});
