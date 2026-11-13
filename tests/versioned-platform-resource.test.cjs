'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const tar = require('tar');

const exec = promisify(execFile);
const installer = path.join(__dirname, '../child/scripts/install-versioned-platform-resource.js');
const name = '@aily-project/tool-idf_esp32s3';

function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

async function createRegistry(t, root) {
    const packages = new Map();
    for (const [version, complete, exitCode] of [
        ['5.5.1', true, 0],
        ['5.5.2', true, 1],
        ['5.5.3', false, 0],
    ]) {
        const directory = path.join(root, 'registry', version);
        const manifest = { name, version, scripts: { postinstall: 'node postinstall.js' } };
        write(path.join(directory, 'package', 'package.json'), JSON.stringify(manifest));
        write(path.join(directory, 'package', 'postinstall.js'), `
            const fs = require('node:fs');
            const path = require('node:path');
            const flags = path.join(process.env.AILY_TOOLS_PATH, 'esp32-arduino-libs@${version}', 'esp32s3', 'flags');
            fs.mkdirSync(flags, { recursive: true });
            fs.writeFileSync(path.join(flags, 'includes'), 'includes ${version}');
            if (${complete}) fs.writeFileSync(path.join(flags, 'defines'), 'defines ${version}');
            process.exitCode = ${exitCode};
        `);
        const archive = path.join(directory, 'package.tgz');
        await tar.c({ cwd: directory, file: archive, gzip: true }, ['package']);
        const body = fs.readFileSync(archive);
        packages.set(version, { manifest, body, integrity: `sha512-${createHash('sha512').update(body).digest('base64')}` });
    }

    const server = http.createServer((request, response) => {
        const route = decodeURIComponent(request.url);
        if (route === '/' + name) {
            const versions = Object.fromEntries([...packages].map(([version, item]) => [version, {
                ...item.manifest,
                dist: { tarball: `${registry}/archives/${version}.tgz`, integrity: item.integrity },
            }]));
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ name, 'dist-tags': { latest: '5.5.3' }, versions }));
            return;
        }
        const archive = /^\/archives\/([\d.]+)\.tgz$/.exec(route);
        const pkg = archive && packages.get(archive[1]);
        if (pkg) {
            response.end(pkg.body);
            return;
        }
        response.writeHead(404).end();
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const registry = `http://127.0.0.1:${server.address().port}`;
    return Buffer.from(registry).toString('base64');
}

test('installing an exact IDF payload preserves sibling chips, previous versions and shared npm records', async t => {
    const temp = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(temp, 'aily-platform-fixture-'));
    t.after(() => {
        assert.equal(path.dirname(root), temp);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const appData = path.join(root, 'shared');
    const tools = path.join(appData, 'tools');
    const flags = (version, chip, file) => path.join(tools, 'esp32-arduino-libs@' + version, chip, 'flags', file);
    const existing = new Map([
        [path.join(appData, 'package.json'), JSON.stringify({ name: 'shared', dependencies: { [name]: '5.4.0' } })],
        [path.join(appData, 'package-lock.json'), JSON.stringify({ name: 'shared', lockfileVersion: 3, packages: {} })],
        [path.join(appData, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '5.4.0' })],
        [flags('5.4.0', 'esp32s3', 'includes'), 'old version includes'],
        [flags('5.4.0', 'esp32s3', 'defines'), 'old version defines'],
        [flags('5.5.1', 'esp32c3', 'includes'), 'sibling includes'],
        [flags('5.5.1', 'esp32c3', 'defines'), 'sibling defines'],
        [flags('5.5.2', 'esp32s3', 'includes'), 'interrupted extraction from before this request'],
    ]);
    for (const [file, content] of existing) write(file, content);
    const encodedRegistry = await createRegistry(t, root);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(?:npm_config_|AILY_REPAIR_READONLY_NPM_PREFIX$)/i.test(key)));
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = [path.dirname(process.execPath), env[pathKey]].filter(Boolean).join(path.delimiter);
    Object.assign(env, {
        AILY_APPDATA_PATH: appData,
        AILY_TOOLS_PATH: tools,
        npm_config_cache: path.join(root, 'npm-cache'),
        npm_config_userconfig: path.join(root, 'user.npmrc'),
        npm_config_globalconfig: path.join(root, 'global.npmrc'),
        npm_config_fetch_retries: '0',
    });
    const install = version => exec(process.execPath, [installer, name, version, encodedRegistry], { cwd: appData, env, timeout: 30_000 });
    const checkPreserved = () => {
        for (const [file, content] of existing) assert.equal(fs.readFileSync(file, 'utf8'), content, file);
        assert.ok(fs.readdirSync(tools).every(entry => !entry.startsWith('.aily-platform-stage-')));
    };

    await install('5.5.1');
    existing.set(flags('5.5.1', 'esp32s3', 'includes'), 'includes 5.5.1');
    existing.set(flags('5.5.1', 'esp32s3', 'defines'), 'defines 5.5.1');
    checkPreserved();

    await assert.rejects(install('5.5.2'), { message: /Platform package installation failed/ });
    assert.equal(fs.existsSync(flags('5.5.2', 'esp32s3', 'defines')), false);
    checkPreserved();

    await assert.rejects(install('5.5.3'), { message: /Package did not materialize/ });
    assert.equal(fs.existsSync(path.join(tools, 'esp32-arduino-libs@5.5.3')), false);
    checkPreserved();
});
