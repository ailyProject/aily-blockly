'use strict';

const fs = require('node:fs');
const { normalizeProcessMessagePortConfig } = require('./child-process-message-port');
const PROTOCOL = 'aily-subapp-node-control-v1';

/** Input is the Main-selected installed package, never a renderer declaration. */
function readNodeControlSource(config) {
    const packageRoot = fs.realpathSync(config.packagePath);
    const manifest = JSON.parse(fs.readFileSync(require('node:path').join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.name !== config.packageName || manifest.version !== config.version) throw new Error('Node control package identity changed');
    const runtime = manifest.ailySubapp?.runtime;
    if (runtime?.nodeControl === undefined) return null;
    const declaration = runtime.nodeControl;
    if (!declaration || Object.getPrototypeOf(declaration) !== Object.prototype
        || Object.keys(declaration).sort().join(',') !== 'protocol' || declaration.protocol !== PROTOCOL) {
        throw new Error('Unsupported Node control declaration');
    }
    const transport = normalizeProcessMessagePortConfig(runtime.processMessagePort);
    if (!transport) throw new Error('Node control requires a registered process message port');
    return Object.freeze({ protocol: PROTOCOL, packageRoot, packageName: manifest.name, version: manifest.version,
        maxMessageBytes: Math.min(1024 * 1024, transport.maxMessageBytes) });
}

module.exports = { PROTOCOL, readNodeControlSource };
