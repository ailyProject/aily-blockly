'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** UI requests use a unique disposable file; legacy/configuration files stay intact. */
function readBuildRequest(filename) {
    const text = fs.readFileSync(filename, 'utf8');
    const config = JSON.parse(text);
    if (/^compile-request-[a-f0-9-]{36}\.json$/.test(path.basename(filename)) && typeof config.currentProjectPath === 'string') {
        const root = fs.realpathSync(config.currentProjectPath);
        const expected = path.join(root, '.temp');
        const actual = fs.realpathSync(path.dirname(filename));
        if (actual === expected && !fs.lstatSync(filename).isSymbolicLink() && fs.readFileSync(filename, 'utf8') === text) {
            fs.unlinkSync(filename);
        }
    }
    return config;
}

module.exports = { readBuildRequest };
