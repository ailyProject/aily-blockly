'use strict';
const { createNpmMutationQueue } = require('../../../electron/npm-mutation-queue');
createNpmMutationQueue({ pollMs: 10 })({ command: 'npm', args: ['install', '--prefix', process.argv[2]] }, {
  onWait: () => process.send('waiting'),
}).then(release => { release(); process.send('acquired', () => process.disconnect()); })
  .catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
