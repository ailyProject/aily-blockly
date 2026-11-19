const { openProjectSyncStorage } = require('../../../electron/project-sync-storage');
const project = process.argv[2];
(async () => {
  const storage = await openProjectSyncStorage(project, () => {});
  await storage.withLock(async access => {
    await access.replace('project.abi', null, 'retained real bytes');
    process.send({ paused: true });
    await new Promise(resolve => process.once('message', resolve));
  });
  process.disconnect();
})().catch(error => { process.send?.({ error: { code: error.code, message: error.message } }); process.exitCode = 1; process.disconnect?.(); });
