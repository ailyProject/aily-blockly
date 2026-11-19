'use strict';
// Production transport/Core, synthetic firmware executor only. Never packaged.
const fs = require('node:fs'), path = require('node:path');
const [debuggerRoot, root, mode = 'normal'] = process.argv.slice(2);
const { startDebuggerServer } = require(path.join(debuggerRoot, 'server'));
const token = process.env.AILY_SIMDEBUG_HOST_TOKEN; delete process.env.AILY_SIMDEBUG_HOST_TOKEN;
startDebuggerServer({ hostToken: token, evidenceRoot: path.join(root, 'evidence'), runtimeManifestPath: path.join(root, 'unused.json'),
    backendFactory: async ({ onEvent }) => {
        let timer;
        fs.writeFileSync(path.join(root, 'started'), '1');
        return { identity: { engine: 'test-double' }, capabilities: ['uart.console'],
            resume: async () => {
                if (mode === 'normal') onEvent({ type: 'uart', data: 'READY' });
                if (mode === 'controlled') timer = setInterval(() => {
                    if (fs.existsSync(path.join(root, 'continue'))) { clearInterval(timer); onEvent({ type: 'uart', data: 'READY' }); }
                }, 10);
            },
            close: async () => { clearInterval(timer); await new Promise(resolve => setTimeout(resolve, 25));
                fs.writeFileSync(path.join(root, 'closed'), '1'); return { resources: { executionUnits: 0 } }; } };
    } }).then(server => {
        process.stdout.write(JSON.stringify({ event: 'ready', data: server.publicInfo }) + '\n');
        if (process.connected) process.once('disconnect', () => void server.stop());
        void server.closed.then(() => { if (process.connected) process.disconnect(); });
    }).catch(() => { console.log(JSON.stringify({ event: 'fatal' })); process.exitCode = 1; });
