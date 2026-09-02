const fs = require('fs');
const path = require('path');

function resolveBuilderInvocation(args, options = {}) {
    const env = options.env || process.env;
    const execPath = options.execPath || process.execPath;
    const entry = String(env.AILY_E2E_BUILDER_ENTRY || '').trim();

    if (!entry) {
        return {
            command: 'aily-builder',
            args: [...args],
            shell: true
        };
    }

    if (env.AILY_E2E !== '1') {
        throw new Error('AILY_E2E_BUILDER_ENTRY 仅允许在 AILY_E2E=1 时使用。');
    }
    if (!path.isAbsolute(entry)) {
        throw new Error('AILY_E2E_BUILDER_ENTRY 必须是绝对路径。');
    }
    if (!fs.existsSync(entry)) {
        throw new Error(`E2E Builder 入口不存在: ${entry}`);
    }

    return {
        command: execPath,
        args: [entry, ...args.map(removeOuterQuotes)],
        shell: false
    };
}

function removeOuterQuotes(value) {
    const text = String(value);
    return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
        ? text.slice(1, -1)
        : text;
}

module.exports = {
    resolveBuilderInvocation
};
