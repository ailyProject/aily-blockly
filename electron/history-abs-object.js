const { MAX_PROJECT_FILE_BYTES, projectFileHash, projectFileFault } = require('./project-file-access');

const magic = Buffer.from('\0aily-abs-tail-v1\0');
const marker = Buffer.from('\n# @project-state:');
const headerSize = magic.length + 32;

// History filenames still bind the complete source, including its original newline and BOM.
function decodeHistoryAbs(bytes, hash, readTail) {
  if (bytes.length < headerSize || !bytes.subarray(0, magic.length).equals(magic)
      || projectFileHash(bytes) === 'sha256:' + hash) return bytes;
  const key = bytes.subarray(magic.length, headerSize).toString('hex');
  const tail = readTail(key);
  if (!tail || !tail.subarray(0, marker.length).equals(marker) || projectFileHash(tail) !== 'sha256:' + key
      || bytes.length - headerSize + tail.length > MAX_PROJECT_FILE_BYTES)
    throw projectFileFault('ABS_CANDIDATE_OBJECT_INVALID', 'Invalid ABS History tail object.');
  const source = Buffer.concat([bytes.subarray(headerSize), tail]);
  if (projectFileHash(source) !== 'sha256:' + hash)
    throw projectFileFault('ABS_CANDIDATE_OBJECT_INVALID', 'ABS History source digest changed.');
  return source;
}

module.exports = { decodeHistoryAbs };
