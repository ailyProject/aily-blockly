// Read-only projection of the installed Builder's current C++ configuration.
// No preprocessing, build hooks, dependency scan, response expansion or output.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { splitArguments } = require('./target-compile-context');

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_CONFIGURATION_BYTES = 16 * 1024 * 1024;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;
const BOARD_PACKAGE = /^@aily-project\/(?:board|coder)-[A-Za-z0-9_.-]+$/;

function unavailableConfiguration() {
    return { schemaVersion: 1, kind: 'aily-resolved-compiler-configuration',
        scope: 'command-line-only', status: 'unavailable', effectiveFqbn: null,
        platformVersion: null, definitions: [],
        limitations: ['cpp-preprocessing-not-performed', 'configuration-unavailable'] };
}

function unavailableInspection() {
    return { compileContext: unavailableConfiguration(), targetMarkers: null };
}

function projectTargetMarkers(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => key !== 'boardId' && key !== 'mcu')) throw new Error('resolved-target-markers');
    const result = {};
    for (const key of ['boardId', 'mcu']) {
        if (value[key] === undefined) continue;
        if (typeof value[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value[key])) {
            throw new Error('resolved-target-markers');
        }
        result[key] = value[key];
    }
    return result;
}

function safeScalar(value) {
    return value.length <= 256 && (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
        || /^[+-]?(?:0[xX][0-9A-Fa-f]+|[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?)[uUlLfF]*$/.test(value));
}

function projectCppCommandLineDefinitions(recipe, effectiveFqbn, platformVersion) {
    if (typeof recipe !== 'string' || Buffer.byteLength(recipe) > MAX_CONFIGURATION_BYTES) {
        return unavailableConfiguration();
    }
    const limitations = new Set(['cpp-preprocessing-not-performed']);
    const definitions = new Map();
    const args = splitArguments(recipe);
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg.startsWith('@')) limitations.add('response-files-not-evaluated');
        if (!/^-[DU]/.test(arg)) continue;
        const operation = arg[1];
        const declaration = arg.length === 2 ? args[++index] : arg.slice(2);
        if (typeof declaration !== 'string') return unavailableConfiguration();
        const separator = declaration.indexOf('=');
        const name = separator < 0 ? declaration : declaration.slice(0, separator);
        if (!NAME.test(name)) { limitations.add('unsupported-definition-value'); continue; }
        let value = operation === 'U' ? null : separator < 0 ? '1' : declaration.slice(separator + 1);
        let state = operation === 'U' ? 'undefined' : 'defined';
        if ((value !== null && !safeScalar(value)) || (operation === 'U' && separator >= 0)) {
            value = null; state = 'ambiguous'; limitations.add('unsupported-definition-value');
        }
        const previous = definitions.get(name);
        if (previous && (previous.state !== state || previous.value !== value)) {
            value = null; state = 'ambiguous'; limitations.add('conflicting-definitions');
        }
        definitions.set(name, { name, value, state });
        if (definitions.size > 128) return unavailableConfiguration();
    }
    return { schemaVersion: 1, kind: 'aily-resolved-compiler-configuration', scope: 'command-line-only',
        status: limitations.size > 1 ? 'partial' : 'available', effectiveFqbn,
        platformVersion, definitions: [...definitions.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
        limitations: [...limitations].sort() };
}

function decodeRequest(encoded) {
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_REQUEST_BYTES / 3) * 4
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('invalid-request');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_REQUEST_BYTES || bytes.toString('base64') !== encoded) throw new Error('invalid-request');
    const request = JSON.parse(bytes.toString('utf8'));
    const keys = ['schemaVersion', 'projectPath', 'boardModule', 'entryPath', 'appDataPath'];
    if (!request || Array.isArray(request) || Object.keys(request).length !== keys.length
        || Object.keys(request).some(key => !keys.includes(key)) || request.schemaVersion !== 1
        || !BOARD_PACKAGE.test(request.boardModule)
        || ['projectPath', 'entryPath', 'appDataPath'].some(key => typeof request[key] !== 'string'
            || request[key].length > 4096 || /[\x00-\x1f\x7f]/.test(request[key]) || !path.isAbsolute(request[key]))) {
        throw new Error('invalid-request');
    }
    return request;
}

function readBytes(filename, maximum) {
    if (fs.statSync(filename).size > maximum) throw new Error('configuration-budget');
    const bytes = fs.readFileSync(filename);
    if (bytes.length > maximum) throw new Error('configuration-budget');
    return bytes;
}

function resolveBuilderPackage(entryPath, readJson = filename => JSON.parse(readBytes(filename, MAX_JSON_BYTES))) {
    const entry = path.resolve(entryPath);
    if (path.basename(entry) !== 'main.js' || path.basename(path.dirname(entry)) !== 'dist') throw new Error('builder-entry');
    const root = path.dirname(path.dirname(entry));
    const manifest = readJson(path.join(root, 'package.json'));
    const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['aily-builder'];
    if (manifest.name !== '@aily-project/aily-builder' || typeof declared !== 'string'
        || path.resolve(root, declared) !== entry || !fs.existsSync(entry)) throw new Error('builder-entry');
    return { root, parser: path.join(root, 'dist', 'src', 'ArduinoConfigParser.js'),
        compiler: path.join(root, 'dist', 'src', 'CompileConfigManager.js'),
        targetMarkers: path.join(root, 'dist', 'src', 'ArduinoCompiler.js') };
}

async function readCompilerConfiguration(request, options = {}) {
    let stage = 'request';
    try {
        request = decodeRequest(Buffer.from(JSON.stringify(request)).toString('base64'));
        const inputs = new Map();
        const capture = (filename, maximum = MAX_JSON_BYTES) => {
            const bytes = readBytes(filename, maximum);
            inputs.set(filename, { maximum, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
            return bytes;
        };
        const json = filename => JSON.parse(capture(filename));
        stage = 'project';
        const project = json(path.join(request.projectPath, 'package.json'));
        const declaredBoards = Object.keys({ ...project.dependencies, ...project.boardDependencies }).filter(name => BOARD_PACKAGE.test(name));
        if (declaredBoards.length !== 1 || declaredBoards[0] !== request.boardModule) throw new Error('board-mismatch');
        const boardRoot = path.join(request.projectPath, 'node_modules', request.boardModule);
        const board = json(path.join(boardRoot, 'board.json'));
        const boardManifest = json(path.join(boardRoot, 'package.json'));
        if (boardManifest.name !== request.boardModule) throw new Error('board-mismatch');
        const dependencies = boardManifest.boardDependencies || {};
        const sdks = Object.entries(dependencies).filter(([name]) => name.startsWith('@aily-project/sdk-'));
        if (sdks.length !== 1 || !VERSION.test(sdks[0][1])) throw new Error('sdk-unavailable');
        const sdkPath = path.join(request.appDataPath, 'sdk', `${sdks[0][0].slice('@aily-project/sdk-'.length)}_${sdks[0][1]}`);
        stage = 'sdk-configuration';
        for (const name of ['boards.txt', 'platform.txt', 'boards.local.txt', 'platform.local.txt']) {
            const filename = path.join(sdkPath, name);
            if (name.includes('.local.') && !fs.existsSync(filename)) {
                inputs.set(filename, null);
            } else capture(filename, MAX_CONFIGURATION_BYTES);
        }
        const command = splitArguments(String(board.compilerParam || ''));
        const boardIndex = command.findIndex(arg => arg === '-b' || arg === '--board');
        const fqbn = boardIndex >= 0 ? command[boardIndex + 1] : null;
        if (typeof fqbn !== 'string' || !/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(fqbn)) throw new Error('board-target');
        const properties = Object.fromEntries(Object.entries(project.projectConfig || {})
            .filter(([, value]) => value !== null && value !== undefined && value !== '')
            .map(([key, value]) => [key, String(value)]));
        const macros = (project.macros ?? project.MACROS ?? project.projectConfig?.macros ?? []).flat(1);
        if (!Array.isArray(macros) || macros.some(value => typeof value !== 'string')) throw new Error('project-macros');
        const toolVersions = {};
        for (const [name, version] of Object.entries(dependencies)) {
            const match = /^@aily-project\/(?:tool|compiler)-(.+)$/.exec(name);
            if (!match) continue;
            if (!VERSION.test(version)) throw new Error('tool-version');
            toolVersions[match[1].startsWith('idf_') ? 'esp32-arduino-libs' : match[1]] = version;
        }
        stage = 'builder';
        const builder = resolveBuilderPackage(request.entryPath, json);
        capture(builder.parser); capture(builder.compiler); capture(builder.targetMarkers);
        const modules = options.loadBuilderModules ? options.loadBuilderModules(builder) : {
            ArduinoConfigParser: require(builder.parser).ArduinoConfigParser,
            CompileConfigManager: require(builder.compiler).CompileConfigManager,
            resolveArtifactTargetMarkers: require(builder.targetMarkers).resolveArtifactTargetMarkers,
        };
        // Parser compatibility variables are confined to this short-lived child.
        const environment = { ...process.env };
        try {
            delete process.env.COMPILER_PATH;
            Object.assign(process.env, { SDK_PATH: sdkPath, TOOLS_PATH: path.join(request.appDataPath, 'tools'),
                SKETCH_NAME: 'sketch', SKETCH_DIR_PATH: path.join(request.projectPath, '.temp', 'sketch'),
                BUILD_PATH: path.join(request.projectPath, '.build') });
            stage = 'parser';
            const parsed = await new modules.ArduinoConfigParser().parseByFQBN(fqbn, properties, toolVersions, macros);
            const silentLogger = { info() {}, warn() {}, error() {}, verbose() {}, debug() {} };
            const configuration = new modules.CompileConfigManager(silentLogger).parseCompileConfig(parsed);
            const effective = parsed.targetSelection?.effectiveFqbn;
            if (typeof effective !== 'string' || effective.length > 16 * 1024
                || !/^[A-Za-z0-9_.:,=-]+$/.test(effective) || !effective.startsWith(fqbn)) throw new Error('resolved-target');
            const version = parsed.targetSelection?.platform?.version;
            if (version !== null && (typeof version !== 'string' || !VERSION.test(version))) throw new Error('platform-version');
            const compileContext = projectCppCommandLineDefinitions(configuration.args?.cpp, effective, version);
            if (compileContext.status === 'unavailable') throw new Error('compiler-configuration-unavailable');
            stage = 'target-markers';
            const targetMarkers = projectTargetMarkers(modules.resolveArtifactTargetMarkers(fqbn, parsed.board));
            stage = 'bookend';
            for (const [filename, fact] of inputs) {
                if (fact === null ? fs.existsSync(filename)
                    : crypto.createHash('sha256').update(readBytes(filename, fact.maximum)).digest('hex') !== fact.sha256) {
                    throw new Error('configuration-changed');
                }
            }
            return { compileContext, targetMarkers };
        } finally {
            for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
            Object.assign(process.env, environment);
        }
    } catch {
        options.onFailure?.(stage);
        return unavailableInspection();
    }
}

async function main() {
    // Vendor diagnostics can contain paths/recipe text; only the bounded DTO
    // and a fixed local stage may cross this process boundary.
    const warn = process.stderr.write.bind(process.stderr);
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};
    let result;
    try {
        if (process.argv.length !== 3) throw new Error('invalid-request');
        result = await readCompilerConfiguration(decodeRequest(process.argv[2]), {
            onFailure: stage => warn(`[ProjectCompilerConfiguration] stage=${stage}\n`),
        });
    } catch { result = unavailableInspection(); warn('[ProjectCompilerConfiguration] stage=request\n'); }
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { decodeRequest, projectCppCommandLineDefinitions, readCompilerConfiguration,
    resolveBuilderPackage, unavailableConfiguration, unavailableInspection };
if (require.main === module) void main();
