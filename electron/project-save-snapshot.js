const { createHash } = require('node:crypto');

function readSaveSnapshot(record, readInput) {
  if (!record || !Object.hasOwn(record, 'saveInputHash')) return record;
  const { saveInputHash, ...request } = record;
  if (request.version !== 1 || request.kind !== 'document-save' || request.nativeSave?.operation !== 'project_save'
    || typeof saveInputHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(saveInputHash)
    || 'document' in request || 'disk' in request) return null;
  const hex = saveInputHash.slice(7);
  const input = readInput(`save-input-${hex}.json`);
  if (input == null || createHash('sha256').update(input).digest('hex') !== hex) return null;
  const { document, disk } = JSON.parse(input.toString());
  return { ...request, document, disk };
}

module.exports = { readSaveSnapshot };
