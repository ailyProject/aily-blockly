'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const documentHash = document => sha(JSON.stringify(canonical(document)));

function inspectDocument(document) {
  const blocks = [], visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    if (typeof value.type === 'string' && typeof value.id === 'string') blocks.push({ id: value.id, type: value.type });
    for (const [key, child] of Object.entries(value)) if (key !== 'fields') visit(child);
  };
  for (const page of document.pages || []) visit(page.content?.blocks);
  visit(document.sharedModel?.procedureBlocks);
  return { documentHash: documentHash(document), pages: (document.pages || []).map(page => page.id),
    blocks: blocks.length, blockIds: blocks.map(block => block.id).sort(),
    variables: (document.sharedModel?.variables || []).length,
    variableHash: documentHash(document.sharedModel?.variables || []),
    blockTypes: Object.fromEntries([...new Set(blocks.map(block => block.type))].sort().map(type =>
      [type, blocks.filter(block => block.type === type).length])) };
}

function packageFiles(root) {
  const result = [];
  const visit = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), key = path.join(relative, entry.name).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error('Original evidence must not contain implicit library links.');
      if (entry.isDirectory()) visit(file, key);
      else if (entry.isFile()) { const bytes = fs.readFileSync(file); result.push({ path: key, bytes: bytes.length, sha256: sha(bytes) }); }
      else throw new Error('Unexpected original evidence file type.');
    }
  };
  visit(root);
  return result;
}

function customerOracle(root) {
  const bytes = fs.readFileSync(path.join(root, 'project.abi'));
  const document = JSON.parse(bytes), manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const definitions = Object.keys(manifest.dependencies || {}).sort().map(name => {
    const logical = path.join(root, 'node_modules', name);
    return { name, requested: manifest.dependencies[name],
      installedVersion: JSON.parse(fs.readFileSync(path.join(logical, 'package.json'))).version,
      files: packageFiles(logical) };
  });
  const resources = Object.fromEntries(['assets', '.assets', 'local-libraries'].filter(name => fs.existsSync(path.join(root, name)))
    .map(name => [name, packageFiles(path.join(root, name))]));
  return { rawAbiSha256: sha(bytes), document: inspectDocument(document), resources,
    manifestSha256: sha(fs.readFileSync(path.join(root, 'package.json'))),
    lockSha256: fs.existsSync(path.join(root, 'package-lock.json')) ? sha(fs.readFileSync(path.join(root, 'package-lock.json'))) : null,
    definitions, definitionClosureHash: documentHash(definitions) };
}

module.exports = { sha, canonical, documentHash, inspectDocument, customerOracle };
