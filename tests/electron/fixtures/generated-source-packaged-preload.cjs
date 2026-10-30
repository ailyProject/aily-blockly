'use strict';
const assert = require('node:assert/strict');
const { contextBridge, app } = require('electron');
assert.equal(app, undefined, 'Exercise the real preload realm, not a main-process app stub.');
for (const name of ['AILY_CHILD_PATH', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) assert.equal(process.env[name], undefined, name);
const publication = require('./build-workspace-publication');
// Late, unrelated environment setup cannot redirect the trusted package layout.
process.env.AILY_CHILD_PATH = 'Z:/not-a-real-child-runtime';
contextBridge.exposeInMainWorld('publicationProbe', {
  version: publication.GENERATED_SOURCE_ARCHIVE_VERSION,
  publish: (project, request) => {
    try { return { ok: true, value: publication.publishArduinoGeneratedCode(project, request) }; }
    catch (error) { return { ok: false, error: error.message }; }
  },
});
