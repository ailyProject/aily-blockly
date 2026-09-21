// Project-owned preprocessing evidence -> shell-free GCC/Clang test arguments.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function captureInputs(files) {
    return [...new Set(files)].map(file => ({ path: path.resolve(file), sha256: hash(file) }));
}

// Arduino recipes quote paths on every platform. Preserve Windows separators;
// only escaped quotes/backslashes and whitespace outside quotes have syntax.
function splitArguments(value) {
    const result = [];
    let token = '', quote = '', started = false;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === '\\' && (value[i + 1] === '"' || value[i + 1] === '\\')) {
            token += value[++i]; started = true;
        } else if (ch === '"' || ch === "'") {
            if (quote === ch) quote = '';
            else if (!quote) quote = ch;
            else token += ch;
            started = true;
        } else if (/\s/.test(ch) && !quote) {
            if (started) result.push(token);
            token = ''; started = false;
        } else { token += ch; started = true; }
    }
    if (quote) throw new Error('Unterminated compiler argument quote');
    if (started) result.push(token);
    return result;
}

function createTargetCompileContext(preprocessPath, project, inputs) {
    const data = JSON.parse(fs.readFileSync(preprocessPath, 'utf8'));
    if (!data.success) throw new Error('Preprocessing did not succeed');
    let compiler = data.envVars?.COMPILER_GPP_PATH;
    if (typeof compiler !== 'string' || !path.isAbsolute(compiler) || !/(?:g\+\+|clang\+\+)(?:\.exe)?$/i.test(compiler))
        throw new Error('No resolved GCC/Clang C++ compiler');
    if (!fs.existsSync(compiler) && process.platform === 'win32') compiler += '.exe';
    const recipe = data.compileConfig?.args?.cpp;
    if (typeof recipe !== 'string') throw new Error('No resolved C++ recipe');
    const responseFiles = new Set();
    function inspectResponses(args, depth = 0) {
        if (depth > 8) throw new Error('Nested compiler response files exceed limit');
        for (const arg of args) {
            if (!arg.startsWith('@')) continue;
            const file = path.resolve(project, arg.slice(1));
            responseFiles.add(file);
            const nested = splitArguments(fs.readFileSync(file, 'utf8'));
            if (nested.some(flag => /^-(?:o|M|MM|MD|MMD|MP|MF|MT|MQ|MJ|save-temps)(?:$|=)/.test(flag)))
                throw new Error('Response file contains output/dependency options: ' + file);
            inspectResponses(nested, depth + 1);
        }
    }
    const args = splitArguments(recipe);
    // Keep response files in argv: expanding a full SDK exceeds Windows command
    // limits and changes compiler-specific response-file quoting semantics.
    inspectResponses(args);
    const flags = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (['-o', '-MF', '-MT', '-MQ', '-MJ'].includes(arg)) {
            if (++i >= args.length) throw new Error('Missing compiler output argument');
            continue;
        }
        if (['-c', '-M', '-MM', '-MD', '-MMD', '-MP', '%SOURCE_FILE_PATH%'].includes(arg)) continue;
        if (arg === '%INCLUDE_PATHS%') {
            for (const dependency of data.dependencies || []) {
                if (typeof dependency.path !== 'string' || !path.isAbsolute(dependency.path))
                    throw new Error('Unresolved dependency include path');
                flags.push('-I' + dependency.path);
            }
        } else {
            if (/%[A-Z_]+%|\{[\w.]+\}|\$\(|\$\{|^-Wp,.*-M|^-save-temps|^-o.+|^-M[FTQJ].+/.test(arg))
                throw new Error('Unsupported/unresolved compiler argument: ' + arg);
            flags.push(arg);
        }
    }
    for (const item of inputs) if (hash(item.path) !== item.sha256)
        throw new Error('Build configuration changed during preprocessing: ' + item.path);
    return {
        version: 1, status: 'ready', source: 'aily-builder-preprocess', project: path.resolve(project),
        compiler, flags, target: data.arduinoConfig?.fqbn ?? null,
        inputs: [...inputs, ...captureInputs([preprocessPath, compiler, ...responseFiles])],
    };
}

function publishTargetCompileContext(preprocessPath, project, inputs) {
    const destination = path.join(path.dirname(preprocessPath), 'target-compile.json');
    let context;
    try { context = createTargetCompileContext(preprocessPath, project, inputs); }
    catch (error) { context = { version: 1, status: 'unavailable', reason: error.message }; }
    // An unsupported test route must not prevent the normal firmware build.
    fs.writeFileSync(destination, JSON.stringify(context, null, 2));
    return context;
}

module.exports = { captureInputs, splitArguments, createTargetCompileContext, publishTargetCompileContext };
