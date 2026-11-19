'use strict';
// Shared by the desktop preparation step and Worker validation. This detects
// documented citool directives; request parsing remains the real tool's job.
const MANIFEST_PATH = 'aily-input/ci-resources.json';
const KIND = 'aily-ci-prepared-resources-v1';
const SDK_PACKAGE = '@aily-project/sdk-ci13xx';
const TOOL_PACKAGE = '@aily-project/tool-citool-cli';
const SDK_VERSIONS = Object.freeze(['1.0.14', '1.0.15', '1.0.17']);
const TOOL_VERSION = '1.2.2';
const SERVICE_URL = 'https://gen.yiyu.pro/ci';
const ASR_FILES = Object.freeze(['asr.bin', 'dnn.bin', 'user_file.bin']);

function headerSource(value) {
  // Match actual citool 1.2.2, not a C++ preprocessor: header detection removes
  // comments but still sees a directive line inside a multiline raw string,
  // and a // comment does not consume the line after a trailing backslash.
  const source = String(value), comments = source.split('');
  const mask = (target, start, end) => { for (let j = start; j < end; j++) if (!/[\r\n]/u.test(source[j])) target[j] = ' '; };
  for (let i = 0; i < source.length;) {
    if (source.startsWith('//', i)) {
      let end = source.indexOf('\n', i + 2); if (end < 0) end = source.length;
      mask(comments, i, end); i = end;
    } else if (source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2), end = close < 0 ? source.length : close + 2;
      mask(comments, i, end); i = end;
    } else i++;
  }
  return comments.join('').split(/\r?\n/u);
}

function detectIntent(source, { linkedNumberPlayback = false } = {}) {
  const lines = headerSource(source);
  let audio = false, recognizer = false;
  // Match SDK postbuild's outer gate against the original source. It uses a
  // raw multiline regex even for a macro line inside a block comment/string.
  // The tool's effective header/request parsing below remains separate.
  const resourceMacros = /^\s*#define\s+(?:VOICEMP3|VOICE|WAKEWORD|COMMAND)\d+\s+/mu.test(String(source));
  // Actual citool 1.2.2 reads command macro lines without stripping block
  // comments (unlike its header detector). Keep the two parsing layers apart.
  const commands = /^\s*#define\s+(?:WAKEWORD|COMMAND)\d+\s+/mu.test(String(source));
  for (const line of lines) {
    const include = line.match(/^\s*#\s*include\s*[<"](ChipIntelliAudio|ChipIntelliASR)\.h[>"]\s*$/u);
    audio ||= include?.[1] === 'ChipIntelliAudio';
    recognizer ||= include?.[1] === 'ChipIntelliASR';
  }
  // SDK postbuild only invokes generate for resource macros or an actual ELF
  // playLocalizedNumber symbol. A mere Audio include must not cause a service
  // call; its overloaded C++ API cannot be inferred from source spelling.
  const generation = resourceMacros || linkedNumberPlayback;
  const asr = generation && recognizer && commands, tts = generation && audio;
  return { asr, tts, required: asr || tts };
}

function mp3References(source) {
  const refs = [];
  for (const line of String(source).split(/\r?\n/u)) {
    if (!/^\s*#define\s+VOICEMP3\d+\b/u.test(line)) continue;
    const match = line.match(/^\s*#define\s+VOICEMP3\d+\s+[^/\r\n]+\/\/\s*(.+?)\s*$/u);
    if (!match) throw new Error('CI MP3 macro must declare its source file comment.');
    refs.push(match[1]);
  }
  return [...new Set(refs)];
}

function expectedFiles(intent) {
  return [...(intent.asr ? ASR_FILES : []), ...(intent.tts ? ['voice.bin'] : [])];
}
function resourceRoot(entry, algorithm = '') {
  if (typeof entry !== 'string' || !entry.startsWith('sketch/') || entry.split('/').some(part => !part || part === '.' || part === '..') || /[\\:\x00-\x1f]/u.test(entry)) throw new Error('Invalid CI source entry.');
  return entry.slice(0, entry.lastIndexOf('/')) + '/recursos' + (['cwsl', 'cwsl_aec'].includes(algorithm) ? '/cwsl' : '');
}

module.exports = { MANIFEST_PATH, KIND, SDK_PACKAGE, TOOL_PACKAGE, SDK_VERSIONS, TOOL_VERSION, SERVICE_URL,
  ASR_FILES, detectIntent, mp3References, expectedFiles, resourceRoot };
