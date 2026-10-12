'use strict';
const { spawn } = require('node:child_process');

const incompatibleArchive = /lto1: internal compiler error: bytecode stream: expected tag record_type instead of error_mark/;

/** Retry only the observed incompatible LTO archive failure, once, under the
 * same host workspace lease and captured inputs. Source errors remain errors. */
async function compileWithArchiveRecovery(command, initialArgs, options, beforeRetry, emit = (type, data) => process[type].write(data)) {
    const output = [];
    const attempt = async (args, holdErrors) => {
        let spawnError = null;
        const errors = [];
        const child = spawn(command, args, options);
        child.stdout.on('data', data => { output.push(String(data)); emit('stdout', data); });
        child.stderr.on('data', data => {
            output.push(String(data)); errors.push(data);
            if (!holdErrors) emit('stderr', data);
        });
        child.once('error', error => {
            spawnError = error;
            output.push(`\n[BUILDER_SPAWN_ERROR] ${error.stack || error.message}\n`);
        });
        const result = await new Promise(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
        return { ...result, spawnError, errors };
    };
    let args = [...initialArgs];
    let result = await attempt(args, true);
    let archiveRecovery = null;
    const retry = !result.spawnError && !result.signal && result.exitCode !== 0
        && !args.includes('--no-archive-cloud-cache') && incompatibleArchive.test(output.join(''));
    if (retry) {
        await beforeRetry();
        archiveRecovery = {
            reason: 'incompatible-lto-archive',
            attempts: 2,
            firstExitCode: result.exitCode,
            firstStderr: Buffer.concat(result.errors).toString('utf8').slice(-256 * 1024)
        };
        const message = '\n[BUILD_CACHE_RECOVERY] Cached LTO archive is incompatible; compiling from source once.\n';
        output.push(message); emit('stdout', message);
        args = args.filter(arg => arg !== '--generate-archive-cloud-cache');
        args.push('--no-archive-cloud-cache', '--no-fetch-archive-cloud-cache');
        // The first attempt is retained in the compile report. Its provisional
        // errors must not permanently mark a successful source retry as failed.
        result = await attempt(args, false);
    } else {
        for (const data of result.errors) emit('stderr', data);
    }
    return { ...result, args, output, recoveredArchive: retry, archiveRecovery };
}

module.exports = { compileWithArchiveRecovery };
