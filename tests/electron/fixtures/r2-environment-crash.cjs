const { LibraryDependencies, runDependencyWorker } = require('../../../electron/library-dependencies');
const root = process.env.AILY_R2_ENV_PROJECT;
const mode = process.env.AILY_R2_ENV_BOUNDARY;
let paused = false;
const api = new LibraryDependencies({ run: async (project, request, hooks) => {
  const result = await runDependencyWorker(project, request, hooks && {
    beforeReify: async (locations, worker, writes) => {
      await hooks.beforeReify(locations, worker, writes);
      if (mode === 'before-reify' && !paused) {
        paused = true;
        process.send({ paused: mode, locations, worker, environment: api.environment.describe(root) });
        await new Promise(() => {});
      }
    },
  });
  if (mode === 'after-prune' && !paused && !request.materializeSources && !request.save) {
    paused = true;
    process.send({ paused: mode, environment: api.environment.describe(root) });
    await new Promise(() => {});
  }
  if (mode === 'after-lock-write' && !paused && request.save) {
    paused = true;
    process.send({ paused: mode, environment: api.environment.describe(root) });
    await new Promise(() => {});
  }
  return result;
} });
api.mutate(root, { action: 'remove', packages: ['r2-parent'], options: { offline: true, ignoreScripts: true } })
  .then(result => mode === 'after-lock-write' ? api.save(root) : result)
  .then(() => { process.send({ unexpectedCompletion: true }); process.exitCode = 2; },
    error => { process.send({ error: error.message, code: error.code }); process.exitCode = 1; });
