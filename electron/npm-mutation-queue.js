'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { childScriptPath } = require('./child-script-path');

// Both npm IPC channels modify the same package tree. Keep the anchor outside
// node_modules: npm reify may rename/remove any package while installing another.
function tryAcquirePrefix(prefix) {
  const directory = path.join(prefix, '.aily');
  fs.mkdirSync(directory, { recursive: true });
  const { tryAcquireFileLock } = require(childScriptPath('native-file-lock.js'));
  const lock = tryAcquireFileLock(path.join(directory, 'npm-mutation.lock'));
  return lock ? () => lock.close() : null;
}

function tokenize(text) {
  const tokens = [];
  let token = '', quote = '';
  for (const char of text.trim()) {
    if (quote) {
      if (char === quote) quote = '';
      else token += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (token) { tokens.push(token); token = ''; }
    } else token += char;
  }
  if (quote) throw new Error('Unterminated npm command quote.');
  if (token) tokens.push(token);
  return tokens;
}

function unquote(value) {
  return /^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value;
}

function canonicalPrefix(value) {
  let resolved = path.resolve(value);
  // Repair scripts run inside a package, but contend with installs at its prefix.
  const segments = resolved.split(path.sep);
  const modules = segments.findIndex(segment => segment.toLowerCase() === 'node_modules');
  if (modules >= 0) resolved = segments.slice(0, modules).join(path.sep) + path.sep;
  let existing = resolved;
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing)); existing = parent;
  }
  resolved = path.join(fs.realpathSync(existing), ...suffix);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const mutations = new Set(['install', 'i', 'add', 'ci', 'update', 'up', 'upgrade',
  'uninstall', 'un', 'remove', 'rm', 'rebuild', 'rb', 'dedupe', 'prune', 'link',
  'run', 'run-script']);
const valuedOptions = new Set(['--prefix', '--userconfig', '--registry', '--cache', '--loglevel', '--workspace', '-w']);

function localPrefix(cwd) {
  let directory = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(directory, 'package.json')) || fs.existsSync(path.join(directory, 'node_modules'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return cwd;
    directory = parent;
  }
}

function npmMutationPrefix({ commandText, command, args = [], cwd = process.cwd(), env = {} }) {
  const tokens = commandText !== undefined ? tokenize(commandText)
    : [unquote(command || ''), ...args.map(unquote)];
  if (!/(?:^|[\\/])npm(?:\.cmd|\.exe)?$/i.test(tokens.shift() || '')) return null;
  let verb, prefix, global = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--') break;
    if (token === '--prefix') { prefix = tokens[++index]; continue; }
    if (token.startsWith('--prefix=')) { prefix = token.slice('--prefix='.length); continue; }
    if (['-g', '--global', '--global=true', '--location=global'].includes(token)) { global = true; continue; }
    if (token === '--global=false') { global = false; continue; }
    if (!verb && !token.startsWith('-')) verb = token.toLowerCase();
    else if (valuedOptions.has(token)) index++;
  }
  if (!mutations.has(verb)) return null;
  const findPrefix = values => Object.entries(values).find(([key]) => key.toLowerCase() === 'npm_config_prefix')?.[1];
  const environmentPrefix = findPrefix(env) || findPrefix(process.env);
  // npm_config_prefix controls the GLOBAL prefix. In this host it is always
  // npm-global; local installs and package repair scripts still use their cwd.
  if (global && !prefix && !environmentPrefix) throw new Error('全局 npm 安装必须指定 --prefix。');
  return canonicalPrefix(path.resolve(cwd, prefix || (global ? environmentPrefix : localPrefix(cwd))));
}

function cancelled() { return new Error('NPM_COMMAND_CANCELLED'); }

function createNpmMutationQueue({ tryAcquire = tryAcquirePrefix, pollMs = 200, timeoutMs = 30 * 60 * 1000 } = {}) {
  const queues = new Map();
  return function acquireNpmMutation(options, { signal, onWait } = {}) {
    const prefix = npmMutationPrefix(options);
    if (!prefix) return null;
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const queue = queues.get(prefix) || [];
      queues.set(prefix, queue);
      let timer, deadline, waiting = false, settled = false;
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
      };
      const remove = () => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        if (!queue.length) queues.delete(prefix);
        else if (index === 0) queue[0].attempt();
      };
      const fail = error => {
        if (settled) return;
        settled = true; cleanup(); remove(); reject(error);
      };
      const abort = () => fail(cancelled());
      const notifyWait = () => {
        if (!waiting) { waiting = true; onWait?.(prefix); }
      };
      const item = { attempt() {
        if (settled) return;
        try {
          if (signal?.aborted) return abort();
          const release = tryAcquire(prefix);
          if (!release) {
            notifyWait(); timer = setTimeout(item.attempt, pollMs); return;
          }
          settled = true; cleanup();
          let released = false;
          resolve(() => {
            if (released) return;
            release(); released = true; remove();
          });
        } catch (error) { fail(error); }
      } };
      queue.push(item);
      signal?.addEventListener('abort', abort, { once: true });
      deadline = setTimeout(() => fail(new Error('等待其他依赖安装超时，请待安装结束后重试。')), timeoutMs);
      if (queue.length === 1) item.attempt();
      else { try { notifyWait(); } catch (error) { fail(error); } }
    });
  };
}

module.exports = { npmMutationPrefix, createNpmMutationQueue, acquireNpmMutation: createNpmMutationQueue() };
