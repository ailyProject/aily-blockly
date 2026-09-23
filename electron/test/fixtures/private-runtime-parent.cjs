'use strict';
const path = require('node:path');
const { launchPrivateRuntime } = require('../../subapp-private-runtime');
const [entry, root, mode] = process.argv.slice(2);
const options = { node: process.execPath, entry,
    args: ['serve', '--runtime-manifest', path.join(root, 'missing.json'), '--evidence-root', path.join(root, 'evidence')],
    credentialEnv: 'AILY_SIMDEBUG_HOST_TOKEN', connect: require(entry).connectHostPeer,
};
if (mode === 'early') {
    const child = require('../../cmd').executeCmdCommand({ command: options.node, args: [entry, ...options.args], shellProfile: false,
        streamId: 'early-parent-exit', messagePort: { transport: 'node-ipc-v1' } }).process;
    process.stdout.write(JSON.stringify({ event: 'parent-fixture', pid: child.pid }) + '\n', () => process.exit(0));
} else launchPrivateRuntime(options).then(runtime => {
    process.stdout.write(JSON.stringify({ event: 'parent-fixture', pid: runtime.publicInfo.pid }) + '\n', () => process.exit(0));
}).catch(error => { console.error(error); process.exit(1); });
