'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** Local process-file-v1 capability. The Runtime, not a surviving host helper,
 * observes process death. Paths and identities never come from renderer input. */
class SubappOwnerProcessLeases {
    constructor(root = os.tmpdir()) { this.root = root; this.directory = null; }

    create(sessionId) {
        this.directory ||= fs.mkdtempSync(path.join(this.root, 'subapp-owner-leases-'));
        const leaseFile = path.join(this.directory, `${randomUUID()}.json`);
        const identity = { sessionId, ownerPid: process.pid };
        fs.writeFileSync(leaseFile, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
        return { ...identity, leaseFile };
    }

    revoke(lease) {
        if (!lease) return;
        if (path.dirname(lease.leaseFile) !== this.directory) throw new Error('Invalid owned process lease path');
        try { fs.unlinkSync(lease.leaseFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

module.exports = { SubappOwnerProcessLeases };
