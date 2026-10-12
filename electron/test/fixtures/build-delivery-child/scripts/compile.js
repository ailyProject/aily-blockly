'use strict';
// Lifecycle fixture, not a firmware compiler. Uses the production owner,
// publication and process-report implementations with synthetic artifact data.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { acquireBuildWorkspace } = require('../../../../../child/scripts/build-workspace-lease');
const { readBuildRequest } = require('../../../../../child/scripts/build-request');
const { captureProjectSources, publishBuildDelivery, reportBuildDelivery } = require('./compile-delivery');
const { createLibraryProjectionRecorder } = require('./library-source-evidence');
const hash = value => createHash('sha256').update(value).digest('hex');
async function main() {
  const config = readBuildRequest(process.argv[2]);
  const owner = acquireBuildWorkspace(config.currentProjectPath, 'compile');
  try {
    fs.writeFileSync(path.join(config.currentProjectPath, '.temp/fixture-pid'), String(process.pid));
    if (config.fixtureOutcome === 'hold') await new Promise(resolve => setTimeout(resolve, 30000));
    const source = path.join(config.currentProjectPath, '.temp/fixture.ino'); fs.writeFileSync(source, config.code);
    const before = captureProjectSources(config);
    const body = { schemaVersion: 1, kind: 'aily-build-input-record', scope: 'build-graph-facts', configurationSha256: 'c'.repeat(64),
      steps: ['sketch', 'libraries', 'core', 'linking'].map(name => ({ kind: 'ninja-plan', name, sha256: 'd'.repeat(64) })) };
    const record = { ...body, digest: hash(JSON.stringify(body)) }, inputBytes = JSON.stringify(record);
    fs.writeFileSync(path.join(config.currentProjectPath, '.build/aily-build-inputs.json'), inputBytes);
    fs.writeFileSync(path.join(config.currentProjectPath, '.build/aily-artifact-manifest.json'), JSON.stringify({
      schemaVersion: 1, kind: 'aily-build-artifact', artifactId: 'a'.repeat(64), target: { fqbn: 'test:core:board' },
      build: { source: { sha256: hash(config.code), sizeBytes: Buffer.byteLength(config.code) },
        inputs: { schemaVersion: 1, kind: 'aily-build-input-reference', scope: 'build-graph-facts', path: 'aily-build-inputs.json', digest: record.digest } },
      files: [{ path: 'aily-build-inputs.json', role: 'build-inputs', sizeBytes: Buffer.byteLength(inputBytes), sha256: hash(inputBytes) }],
    }));
    const libraries = createLibraryProjectionRecorder().snapshot(config);
    fs.writeFileSync(path.join(config.currentProjectPath, '.build/aily-library-projections.json'), JSON.stringify(libraries));
    const receipt = publishBuildDelivery(config, before, source, 'test:core:board', libraries, owner.buildId);
    if (config.fixtureOutcome !== 'no-message') await reportBuildDelivery(config, receipt);
    if (config.fixtureOutcome === 'failed') process.exitCode = 7;
  } finally { owner.release(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
