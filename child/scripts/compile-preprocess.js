const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

/** Background preprocess output is advisory, never proof for a later source snapshot.
 * Refresh dependency discovery for the exact compile input; keep Builder object/archive caches.
 */
async function runCompilePreprocess(config, tempPath, resultPath, launch = spawn) {
    const snapshot = path.join(tempPath, `compile-preprocess-${randomUUID()}.json`);
    fs.writeFileSync(snapshot, JSON.stringify(config));
    try {
        // Remove only this derived dependency result, never compiled objects or libraries.
        fs.rmSync(resultPath, { force: true });
        await new Promise((resolve, reject) => {
            const child = launch(process.execPath, [path.join(__dirname, 'preprocess.js'), snapshot], {
                cwd: config.currentProjectPath, stdio: 'inherit', windowsHide: true,
            });
            child.once('error', reject);
            child.once('close', (code, signal) => {
                if (code === 0 && !signal) resolve();
                else reject(new Error(`Compile dependency preprocessing failed (${signal || code}).`));
            });
        });
        if (!fs.existsSync(resultPath) || JSON.parse(fs.readFileSync(resultPath, 'utf8')).success !== true) {
            throw new Error('Compile dependency preprocessing did not produce a successful current result.');
        }
    } finally { fs.rmSync(snapshot, { force: true }); }
}

module.exports = { runCompilePreprocess };
