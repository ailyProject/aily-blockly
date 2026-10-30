'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { captureBuildSource } = require('./build-source-capture');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));

/** Prepare an isolated source project, then use the normal Host compilation entry. */
async function compileBoardDemonstration(boardDirectory, demonstrationDirectory, appDataDirectory, expectedGraph, program) {
    const boardRoot = await fs.realpath(boardDirectory);
    const demoRoot = await fs.realpath(demonstrationDirectory);
    const appData = await fs.realpath(appDataDirectory);
    const board = await json(path.join(boardRoot, 'package.json'));
    const definition = await json(path.join(boardRoot, 'board.json'));

    if (program !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(program)) throw new Error('Invalid demonstration program.');

    const directory = program ? path.join(demoRoot, 'programs', program) : demoRoot;
    const recipe = await json(path.join(demoRoot, 'build.json'));
    const circuit = await json(path.join(directory, 'circuit.json'));
    const directions = await json(path.join(directory, 'gpio-directions.json'));
    const code = await fs.readFile(path.join(directory, 'sketch.ino'), 'utf8');

    if (recipe.schemaVersion !== 1 || recipe.fqbn !== definition.type
        || circuit.graphSemanticRevision !== expectedGraph || directions.graphSemanticRevision !== expectedGraph
        || !/^@[^/\\]+\/[^/\\]+$/.test(board.name) || !recipe.options || typeof recipe.options !== 'object') {
        throw new Error('Board demonstration source, circuit, or build configuration differs.');
    }

    const version = spawnSync('aily-builder', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });

    if (version.status !== 0) throw new Error('Aily Builder is unavailable. Install the board build tools before starting the demonstration.');

    const cacheKey = digest(JSON.stringify({ board: { name: board.name, version: board.version, dependencies: board.boardDependencies },
        definition, recipe, code, graph: expectedGraph, directions, builder: version.stdout.trim() }));

    const root = path.join(appData, 'temp', 'simulator-demonstrations', cacheKey);
    const manifestPath = path.join(root, '.build', 'aily-artifact-manifest.json');
    const sourceSha256 = digest(code);

    if (await validCachedArtifact(manifestPath, expectedGraph, sourceSha256)) return { root, cached: true };

    await fs.mkdir(path.join(root, '.temp', 'sketch'), { recursive: true });

    const boardCopy = path.join(root, 'node_modules', board.name);

    await fs.mkdir(boardCopy, { recursive: true });
    await fs.writeFile(path.join(boardCopy, 'package.json'), JSON.stringify(board));
    await fs.writeFile(path.join(boardCopy, 'board.json'), JSON.stringify(definition));

    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'board-demonstration', version: '1.0.0',
        dependencies: { [board.name]: board.version }, projectConfig: recipe.options }));

    await fs.writeFile(path.join(root, '.temp', 'sketch', 'sketch.ino'), code);

    const directionsPath = path.join(root, '.temp', 'gpio-directions.json');

    await fs.writeFile(directionsPath, JSON.stringify(directions));

    const config = { currentProjectPath: root, boardModule: board.name, code, appDataPath: appData,
        devmode: false, recordBuildInputs: true, graphSemanticRevision: expectedGraph, sourceDocumentSchemaVersion: 2,
        sceneGpioDirectionsPath: directionsPath };

    config.sourceCapture = captureBuildSource(config);
    const requestPath = path.join(root, '.temp', `compile-request-${randomUUID()}.json`);

    await fs.writeFile(requestPath, JSON.stringify(config));

    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'compile.js'), requestPath], {
            stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
        });

        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Board demonstration compilation failed (${code}).`)));
    });

    if (!await validCachedArtifact(manifestPath, expectedGraph, sourceSha256)) throw new Error('Compiled demonstration Artifact failed verification.');

    return { root, cached: false };
}

async function validCachedArtifact(filename, graph, source) {
    try {
        const artifact = await json(filename);

        if (!artifact.build?.inputs || artifact.build?.graph?.graphSemanticRevision !== graph || artifact.build?.source?.sha256 !== source
            || !Array.isArray(artifact.files) || !artifact.files.length) return false;

        for (const file of artifact.files) {
            if (typeof file.path !== 'string' || path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) return false;

            const bytes = await fs.readFile(path.join(path.dirname(filename), file.path));

            if (bytes.length !== file.sizeBytes || digest(bytes) !== file.sha256) return false;
        }

        return true;
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;

        throw error;
    }
}

if (require.main === module) {
    compileBoardDemonstration(...process.argv.slice(2)).then(result => {
        console.log(`AILY_DEMO_BUILD ${JSON.stringify(result)}`);
    }).catch(error => {
        console.error(error.message);

        process.exitCode = 1;
    });
}

module.exports = { compileBoardDemonstration };
