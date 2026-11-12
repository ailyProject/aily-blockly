'use strict';

const legacyToolVersions = {
    'ctags@5.8.0': '5.8-arduino11',
    'pqt-mklittlefs@4.1.0': '4.1.0-1aec55e',
    'pqt-picotool@4.1.0': '4.1.0-1aec55e',
    'pqt-pioasm@4.1.0': '4.1.0-1aec55e',
    'pqt-python3@1.0.1': '1.0.1-base-3a57aed-1',
};

function platformResourcePaths(kind, name, version, entries = []) {
    const flat = [`${name}@${version}`, `${name}_${version}`];
    const paths = kind === 'sdk' ? [...flat].reverse() : flat;
    paths.push(`${name}/${version}`);
    if (kind !== 'tool') return paths;

    const alias = legacyToolVersions[`${name}@${version}`];
    if (alias) paths.push(`${name}@${alias}`);
    const compatibleVersions = new Set([version, version.replace(/\.0$/, '')]);
    for (const entry of [...entries].sort()) {
        if (!entry.startsWith(name + '@')) continue;
        const match = /^(\d+(?:\.\d+){1,2})-arduino\d+$/.exec(entry.slice(name.length + 1));
        if (match && compatibleVersions.has(match[1]) && !paths.includes(entry)) paths.push(entry);
    }
    return paths;
}

function requiredToolFiles(name, windows) {
    if (name === 'esptool_py') {
        const file = 'esptool' + (windows ? '.exe' : '');
        return [[file], ['bin/' + file]];
    }
    if (/^esp32[a-z0-9]*-libs$/.test(name)) return [['flags/includes', 'flags/defines']];
    return [];
}

function findToolPayload(name, windows, isFile, list) {
    const required = requiredToolFiles(name, windows);
    if (required.length) return required.find(files => files.every(isFile)) || [];
    for (const folder of ['', 'bin/', 'win/']) {
        const files = list(folder);
        const binary = files.find(file => (windows ? /\.exe$/i.test(file) : !file.includes('.')) && isFile(folder + file));
        if (binary) return [folder + binary];
    }
    // Header bundles and other data tools may have no launcher.
    for (const folder of list('')) {
        const file = list(folder + '/').find(entry => isFile(folder + '/' + entry));
        if (file) return [folder + '/' + file];
    }
    return list('').filter(file => !/^(?:\.|readme|licen[cs]e|package\.json)/i.test(file) && isFile(file)).slice(0, 1);
}

module.exports = { platformResourcePaths, findToolPayload };
