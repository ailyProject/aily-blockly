'use strict';
const { isDeepStrictEqual } = require('node:util');

const valueOf = entry => String(Array.isArray(entry) ? entry[0] : entry).trim();
function userMacros(manifest) {
  return (Array.isArray(manifest.MACROS) ? manifest.MACROS : []).filter(entry => {
    const value = valueOf(entry), name = value.split('=')[0];
    return !value || manifest.ailyGeneratorMacros?.[name] !== value;
  });
}

/** The dependency owner does not own build fingerprints or unchanged macros
 * explicitly owned by code generation. User-authored macro changes still count. */
function manifestInput(text) {
  if (text === null) return null;
  const { codeHash, buildInfo, ailyGeneratorMacros, MACROS, ...manifest } = JSON.parse(text);
  const macros = userMacros({ MACROS, ailyGeneratorMacros });
  if (macros.length) manifest.MACROS = macros;
  if (MACROS !== undefined && !Array.isArray(MACROS)) manifest.MACROS = MACROS;
  return manifest;
}

function environmentManifest(text) {
  const manifest = manifestInput(text); if (manifest === null) return null;
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'boardDependencies',
    'ailyLocalLibrarySources', 'ailyBoardOverrides', 'projectConfig', 'devmode', 'MACROS', 'blocklyToolboxOrder', 'framework', 'compileBackend'];
  return Object.fromEntries(fields.filter(name => Object.hasOwn(manifest, name)).map(name => [name, manifest[name]]));
}

function retainDerivedManifest(targetText, currentText) {
  const target = JSON.parse(targetText), current = JSON.parse(currentText);
  const result = { ...target };
  for (const field of ['codeHash', 'buildInfo']) {
    if (Object.hasOwn(current, field)) result[field] = current[field]; else delete result[field];
  }
  const user = userMacros(target), names = new Set(user.map(entry => valueOf(entry).split('=')[0]));
  const liveMacros = Array.isArray(current.MACROS) ? current.MACROS : [];
  const owned = Object.fromEntries(Object.entries(current.ailyGeneratorMacros || {}).filter(([name, value]) =>
    !names.has(name) && liveMacros.some(entry => valueOf(entry) === value)));
  if (Object.keys(owned).length || Object.hasOwn(current, 'ailyGeneratorMacros')) result.ailyGeneratorMacros = owned;
  else delete result.ailyGeneratorMacros;
  if (user.length || Object.keys(owned).length || Array.isArray(target.MACROS) || Array.isArray(current.MACROS)) {
    result.MACROS = [...user, ...Object.values(owned).map(value => [value])];
  }
  return JSON.stringify(result) === JSON.stringify(target) ? targetText : JSON.stringify(result, null, 2);
}

/** Roll back only keys changed by this environment operation. Independent
 * project metadata, including later generated fields, remains with its owner. */
function restoreEnvironmentManifest(beforeText, desiredText, currentText) {
  const before = manifestInput(beforeText), desired = manifestInput(desiredText ?? beforeText);
  const current = JSON.parse(currentText), semantic = manifestInput(currentText);
  const result = { ...current };
  for (const key of new Set([...Object.keys(before), ...Object.keys(desired)])) {
    if (isDeepStrictEqual(before[key], desired[key])) continue;
    if (!isDeepStrictEqual(semantic[key], before[key]) && !isDeepStrictEqual(semantic[key], desired[key])) {
      throw Object.assign(new Error('An owned environment input changed after its original operation.'), { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
    }
    if (Object.hasOwn(before, key)) result[key] = before[key]; else delete result[key];
  }
  const target = isDeepStrictEqual(result, JSON.parse(beforeText)) ? beforeText : JSON.stringify(result);
  return retainDerivedManifest(target, currentText);
}

module.exports = { environmentManifest, manifestInput, retainDerivedManifest, restoreEnvironmentManifest };
