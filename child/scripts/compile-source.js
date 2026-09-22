'use strict';

const fs = require('node:fs');
const path = require('node:path');
const project = require('./aily-code-project');

function assertPhysicalTree(root) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink()) throw new Error(`Compile source must not traverse a symlink/junction: ${root}`);
    if (stat.isDirectory()) {
        for (const name of fs.readdirSync(root)) assertPhysicalTree(path.join(root, name));
    } else if (!stat.isFile()) throw new Error(`Unsupported compile source: ${root}`);
}

/** Only the derived Blockly sketch is replaceable. Coder's sketch is user-owned. */
async function prepareCompileSource(config) {
    const root = fs.realpathSync(config.currentProjectPath);
    if (typeof config.code !== 'string') throw new Error('Compile code must be a string.');
    if (project.isAilyCodeProjectRoot(root)) {
        const filename = project.resolveCompileSourcePath(root);
        // Check every existing ancestor; an entry inside a junction is not project-owned.
        for (let cursor = filename; cursor !== root; cursor = path.dirname(cursor)) {
            if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
                throw new Error(`Coder entry traverses a symlink/junction: ${cursor}`);
            }
        }
        const previous = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : undefined;
        if (config.recordProjectDelivery === true && previous !== config.code) {
            throw new Error('PROJECT_INPUTS_CHANGED: Coder entry differs from the requested build; save and retry.');
        }
        if (previous !== config.code) {
            fs.mkdirSync(path.dirname(filename), { recursive: true });
            fs.writeFileSync(filename, config.code);
        }
        return filename;
    }

    const temporary = path.join(root, '.temp');
    const destination = path.join(temporary, 'sketch');
    const source = path.join(root, 'src');
    if (fs.existsSync(source)) assertPhysicalTree(source);
    // Validate the exact, owned destination before recursive removal. Never follow links.
    if (fs.existsSync(temporary) && fs.realpathSync(temporary) !== temporary) {
        throw new Error('Blockly temporary directory must not be a symlink/junction.');
    }
    if (fs.existsSync(destination)) assertPhysicalTree(destination);
    fs.mkdirSync(temporary, { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination);
    if (fs.existsSync(source)) {
        // Async cp avoids the bundled Node's Windows Unicode cpSync crash.
        await fs.promises.cp(source, destination, { recursive: true });
    }
    const filename = path.join(destination, 'sketch.ino');
    // Generated code owns the entry, even when src contains an old sketch.ino.
    fs.writeFileSync(filename, config.code);
    return filename;
}

module.exports = { prepareCompileSource };
