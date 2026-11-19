'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { openProjectSyncStorage } = require('../../../electron/project-sync-storage');
const { LibraryEnvironmentJournal } = require('../../../electron/library-environment-journal');
const [root, bundle] = process.argv.slice(2);
const kernel = require(bundle);
const guard = () => {};

process.on('message', async ({ submission, environment }) => {
  try {
    const io = await openProjectSyncStorage(root, guard);
    const { ref } = await new kernel.AbsOperationJournal(io, root).beginDocumentSave(submission, guard);
    if (environment) {
      const journal = new LibraryEnvironmentJournal();
      journal.begin(root, { ...environment, programRef: ref }, null, guard);
      fs.writeFileSync(path.join(root, 'package.json'), environment.files['package.json'].content);
      journal.complete(root, guard);
    }
    process.send({ event: 'admitted', ref });
  } catch (error) {
    process.send({ event: 'failed', message: error.message, code: error.code });
  }
});
