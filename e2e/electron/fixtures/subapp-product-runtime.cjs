'use strict';
// A host-launched wrapper over the test-owned external Runtime, equivalent to
// adopting a daemon that outlives a single host window. Only hardware is fake.
const fs = require('node:fs');
const descriptor = JSON.parse(fs.readFileSync(process.env.AILY_PRODUCT_RUNTIME_DESCRIPTOR, 'utf8'));
process.stdout.write(JSON.stringify({ event: 'ready', data: { ...descriptor, pid: process.pid, sharedRuntime: true } }) + '\n');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
