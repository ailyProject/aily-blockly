'use strict';
// Run under the deployed Electron Node too: Windows path stat and fstat can
// expose different device-number availability despite referring to one file.
const assert = require('node:assert/strict'), fs = require('node:fs/promises');
const path = require('node:path'), os = require('node:os');
const { createEvidenceRun, finishEvidenceRun, readEvidence } = require('../../../aily-subapp/packages/simulator-debugger/runtime/evidence-store');
(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-electron-evidence-'));
    try {
        const dir = await createEvidenceRun(root);
        await fs.writeFile(path.join(dir, 'events.jsonl'), '{"data":"中文🙂"}\n');
        const report = { kind: 'aily-firmware-debug-report', outcome: 'passed', cleanup: { notStarted: true },
            finishedAt: new Date().toISOString(), evidence: { directory: dir } };
        await finishEvidenceRun(root, dir, report);
        for (const file of ['report', 'events']) {
            const result = await readEvidence(root, { runId: report.evidence.runId, file });
            assert.equal(result.text, await fs.readFile(path.join(dir, file === 'report' ? 'report.json' : 'events.jsonl'), 'utf8'));
            assert.equal(result.eof, true);
        }
        console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, passed: true }));
    } finally {
        assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^sim-electron-evidence-/);
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
