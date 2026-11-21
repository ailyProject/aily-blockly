const fs = require('node:fs');
const path = require('node:path');
const { openProjectSyncStorage } = require('../../../electron/project-sync-storage');
const [, , project, cut] = process.argv;
const marker = path.join(project, '.aily', 'project-files.write.lock');
const checkpoint = stage => {
  fs.writeFileSync(path.join(project, 'lock-cut.json'), JSON.stringify({ stage, pid: process.pid }));
  // Block synchronously so the parent terminates the process without running acquisition cleanup.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const files = { ...fs,
  openSync(target, flags, ...rest) {
    const descriptor = fs.openSync(target, flags, ...rest);
    if (cut === 'before-identity-write' && flags === 'wx'
      && path.dirname(target) === path.dirname(marker)) checkpoint(target);
    return descriptor;
  },
  linkSync(source, target) {
    fs.linkSync(source, target);
    if (cut === 'after-identity-publish' && target === marker) checkpoint(source);
  },
};
(async () => {
  const storage = await openProjectSyncStorage(project, () => {}, { files });
  await storage.withLock(async access => {
    await access.replace('project.abi', null, 'retained real bytes');
    process.send({ paused: true });
    await new Promise(resolve => process.once('message', resolve));
  });
  process.disconnect();
})().catch(error => { process.send?.({ error: { code: error.code, message: error.message } }); process.exitCode = 1; process.disconnect?.(); });
