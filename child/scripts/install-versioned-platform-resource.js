'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findToolPayload, platformResourcePaths } = require('./platform-resource-layout.cjs');

const RESOURCE_ENV = { sdk: 'AILY_SDK_PATH', compiler: 'AILY_COMPILERS_PATH', tool: 'AILY_TOOLS_PATH' };

function readExisting(read, fallback) {
    try {
        return read();
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return fallback;
        throw error;
    }
}

function hasPayload(directory, kind, name) {
    const list = relative => readExisting(() => fs.readdirSync(path.join(directory, relative)), []);
    const isFile = relative => readExisting(() => {
        const stat = fs.statSync(path.join(directory, relative));
        return stat.isFile() && stat.size > 0;
    }, false);
    if (kind === 'sdk') return ['boards.txt', 'platform.txt'].every(isFile);
    if (kind === 'compiler') {
        return list('bin').some(file => isFile('bin/' + file));
    }
    return findToolPayload(name, process.platform === 'win32', isFile, list).length > 0;
}

function installVersionedPlatformResource(packageName, version, registry = '') {
    const match = /^@aily-project\/(sdk|compiler|tool)-([a-zA-Z0-9][a-zA-Z0-9_.-]*)$/.exec(packageName || '');
    if (!match || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(version || '')) {
        throw new Error('Expected an exact versioned platform package');
    }
    const [, kind, name] = match;
    if (name.startsWith('idf_')) throw new Error('Unsupported shared tool package layout');
    const base = process.env[RESOURCE_ENV[kind]];
    if (!base || !path.isAbsolute(base) || process.env.AILY_REPAIR_READONLY_NPM_PREFIX) {
        throw new Error('Writable platform resource directory required');
    }
    if (registry) {
        const url = new URL(registry);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid platform package registry');
    }
    fs.mkdirSync(base, { recursive: true });
    const root = fs.realpathSync(base);
    const stage = fs.mkdtempSync(path.join(root, '.aily-platform-stage-'));
    let preserveStage = false;
    try {
        const env = { ...process.env };
        for (const [resource, key] of Object.entries(RESOURCE_ENV)) {
            env[key] = path.join(stage, resource);
            fs.mkdirSync(env[key]);
        }
        if (registry) {
            env.npm_config_registry = registry;
            env['npm_config_@aily-project:registry'] = registry;
        }
        const prefix = path.join(stage, 'npm');
        fs.mkdirSync(prefix);
        const args = ['install', packageName + '@' + version, '--prefix', prefix, '--no-save', '--no-audit',
            '--no-fund', '--foreground-scripts'];
        const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
        const result = fs.existsSync(npm)
            ? spawnSync(process.execPath, [npm, ...args], { env, stdio: 'inherit', windowsHide: true })
            : spawnSync('npm', args, { env, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error('Platform package installation failed (' + result.status + ')');

        const outputRoot = env[RESOURCE_ENV[kind]];
        const directoryName = platformResourcePaths(kind, name, version, fs.readdirSync(outputRoot)).find(candidate => {
            const output = path.join(outputRoot, candidate);
            return readExisting(() => fs.lstatSync(output).isDirectory(), false) && hasPayload(output, kind, name);
        });
        if (!directoryName) throw new Error('Package did not materialize ' + packageName + '@' + version);
        const source = path.join(outputRoot, directoryName);
        const destination = path.join(root, directoryName);
        const parent = path.dirname(destination);
        if (parent !== root) {
            if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
            if (!fs.lstatSync(parent).isDirectory()) throw new Error('Unsafe platform package destination');
        }
        const previous = path.join(stage, 'previous');
        if (fs.existsSync(destination)) {
            if (!fs.lstatSync(destination).isDirectory()) throw new Error('Unsafe platform package destination');
            if (hasPayload(destination, kind, name) && kind !== 'compiler') return;
            fs.renameSync(destination, previous);
        }
        try {
            fs.renameSync(source, destination);
        } catch (error) {
            if (fs.existsSync(previous)) {
                preserveStage = true;
                if (!fs.existsSync(destination)) {
                    fs.renameSync(previous, destination);
                    preserveStage = false;
                }
            }
            throw error;
        }
    } finally {
        if (!preserveStage) fs.rmSync(stage, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        const [name, version, encodedRegistry] = process.argv.slice(2);
        installVersionedPlatformResource(name, version, encodedRegistry ? Buffer.from(encodedRegistry, 'base64').toString('utf8') : '');
    }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
