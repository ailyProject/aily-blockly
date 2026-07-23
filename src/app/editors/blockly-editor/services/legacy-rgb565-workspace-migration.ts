type JsonObject = Record<string, unknown>;

const RAW_ASSET_TYPES: Readonly<Record<string, string>> = {
  seeed_gfx_animation: 'seeed_gfx_rgb565_animation',
  tftscr_animation: 'tftscr_rgb565_animation',
};

const RAW_PARENT_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  seeed_gfx_rgb565_animation: {
    seeed_gfx_play_animation: 'seeed_gfx_play_rgb565_animation',
    seeed_gfx_draw_animation_frame: 'seeed_gfx_draw_rgb565_animation_frame',
    seeed_gfx_animation_frame_count: 'seeed_gfx_rgb565_animation_frame_count',
  },
  tftscr_rgb565_animation: {
    tftscr_play_animation: 'tftscr_play_rgb565_animation',
    tftscr_draw_animation_frame: 'tftscr_draw_rgb565_animation_frame',
    tftscr_animation_frame_count: 'tftscr_rgb565_animation_frame_count',
  },
};

const LEGACY_SEEED_SD_TYPE = 'seeed_gfx_play_sd_video';
const LEGACY_SEEED_SD_COMPAT_TYPE = 'seeed_gfx_play_sd_rgb565_legacy_video';
const AMBIGUOUS_TFT_TF_TYPE = 'tftscr_play_tf_animation';
const RAW_TFT_TF_TYPE = 'tftscr_play_tf_rgb565_video';
const LEGACY_TFT_TF_COMPAT_TYPE = 'tftscr_play_tf_rgb565_legacy_video';

/**
 * Migrates only the historical, frame-array RGB animation contract.
 *
 * The function is deterministic and does not mutate its input. Unchanged
 * branches retain their original references, which avoids copying large
 * Base64 frame strings a second time during workspace loading.
 */
export function migrateLegacyRgb565WorkspaceSerialization<T>(payload: T): T {
  if (!isObject(payload)) return payload;

  const blocksState = payload['blocks'];
  if (Array.isArray(blocksState)) {
    const migratedBlocks = migrateBlockArray(blocksState);
    return migratedBlocks === blocksState
      ? payload
      : { ...payload, blocks: migratedBlocks } as T;
  }

  if (!isObject(blocksState) || !Array.isArray(blocksState['blocks'])) return payload;
  const topBlocks = blocksState['blocks'];
  const migratedBlocks = migrateBlockArray(topBlocks);
  if (migratedBlocks === topBlocks) return payload;

  return {
    ...payload,
    blocks: {
      ...blocksState,
      blocks: migratedBlocks,
    },
  } as T;
}

/** Migrates a standalone serialized block array, such as shared procedures. */
export function migrateLegacyRgb565SerializedBlocks<T extends unknown[]>(blocks: T): T {
  return migrateBlockArray(blocks) as T;
}

function migrateBlockArray(blocks: unknown[]): unknown[] {
  let migrated: unknown[] | null = null;
  for (let index = 0; index < blocks.length; index += 1) {
    const original = blocks[index];
    const next = migrateBlock(original);
    if (next !== original) {
      migrated ??= blocks.slice();
      migrated[index] = next;
    }
  }
  return migrated ?? blocks;
}

function migrateBlock(candidate: unknown): unknown {
  if (!isObject(candidate)) return candidate;

  let block = candidate;
  const migratedInputs = migrateInputs(block['inputs']);
  if (migratedInputs !== block['inputs']) block = { ...block, inputs: migratedInputs };

  const migratedNext = migrateNext(block['next']);
  if (migratedNext !== block['next']) block = { ...block, next: migratedNext };

  const originalType = typeof block['type'] === 'string' ? block['type'] : '';
  let migratedType = originalType;

  const rawAssetType = RAW_ASSET_TYPES[originalType];
  if (rawAssetType && hasLegacyRawAnimationEnvelope(block)) {
    migratedType = rawAssetType;
  } else if (originalType === LEGACY_SEEED_SD_TYPE) {
    // The historical block always played one pass. Keep that behavior even
    // when the AILY header's loop bit is set by routing it through the hidden
    // compatibility handler rather than the new explicit raw player.
    migratedType = LEGACY_SEEED_SD_COMPAT_TYPE;
  } else if (originalType === AMBIGUOUS_TFT_TF_TYPE) {
    const rawPlaybackKind = classifyLegacyRawTfPlayback(block);
    if (rawPlaybackKind === 'legacy') migratedType = LEGACY_TFT_TF_COMPAT_TYPE;
    if (rawPlaybackKind === 'explicit') migratedType = RAW_TFT_TF_TYPE;
  } else {
    const animationType = getEffectiveInputBlockType(block, 'ANIMATION');
    const parentMigration = animationType ? RAW_PARENT_TYPES[animationType]?.[originalType] : undefined;
    if (parentMigration) migratedType = parentMigration;
  }

  return migratedType === originalType ? block : { ...block, type: migratedType };
}

function migrateInputs(candidate: unknown): unknown {
  if (!isObject(candidate)) return candidate;

  let inputs = candidate;
  for (const [name, input] of Object.entries(candidate)) {
    if (!isObject(input)) continue;
    let migratedInput = input;

    for (const connectionName of ['block', 'shadow'] as const) {
      const child = input[connectionName];
      const migratedChild = migrateBlock(child);
      if (migratedChild !== child) {
        migratedInput = migratedInput === input ? { ...input } : migratedInput;
        migratedInput[connectionName] = migratedChild;
      }
    }

    if (migratedInput !== input) {
      inputs = inputs === candidate ? { ...candidate } : inputs;
      inputs[name] = migratedInput;
    }
  }
  return inputs;
}

function migrateNext(candidate: unknown): unknown {
  if (!isObject(candidate)) return candidate;
  const child = candidate['block'];
  const migratedChild = migrateBlock(child);
  return migratedChild === child ? candidate : { ...candidate, block: migratedChild };
}

function hasLegacyRawAnimationEnvelope(block: JsonObject): boolean {
  const fields = block['fields'];
  if (!isObject(fields)) return false;
  const envelope = parseFieldObject(fields['CUSTOM_ANIMATION']);
  if (!envelope || envelope['version'] !== 1 || !Array.isArray(envelope['frames'])) return false;

  return (envelope['format'] === 'rgb565' && envelope['encoding'] === 'rgb565-be-base64')
    || (envelope['format'] === 'rgb332' && envelope['encoding'] === 'rgb332-base64');
}

function parseFieldObject(value: unknown): JsonObject | null {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getEffectiveInputBlockType(block: JsonObject, inputName: string): string | null {
  const inputs = block['inputs'];
  if (!isObject(inputs)) return null;
  const input = inputs[inputName];
  if (!isObject(input)) return null;
  const connected = isObject(input['block']) ? input['block'] : input['shadow'];
  return isObject(connected) && typeof connected['type'] === 'string' ? connected['type'] : null;
}

function classifyLegacyRawTfPlayback(block: JsonObject): 'legacy' | 'explicit' | null {
  const filename = getStaticFilename(block);
  // A dynamic filename cannot disambiguate the historical raw block from the
  // current AANI block because both used the same block type. Prefer leaving
  // it untouched over silently converting a valid AANI block; users can
  // replace the rare legacy dynamic-path block explicitly.
  if (!filename) return null;
  if (/\.aani\s*$/i.test(filename)) return null;

  const inputs = block['inputs'];
  const hasExplicitRange = isObject(inputs)
    && ['X', 'Y', 'START_FRAME', 'FRAME_COUNT'].some(name => name in inputs);
  if (!hasExplicitRange) return 'legacy';
  return /\.rgb565v\s*$/i.test(filename) ? 'explicit' : null;
}

function getStaticFilename(block: JsonObject): string | null {
  const fields = block['fields'];
  if (isObject(fields)) {
    const directFilename = fields['FILENAME'];
    if (typeof directFilename === 'string') return directFilename;
    if (isObject(directFilename) && typeof directFilename['value'] === 'string') {
      return directFilename['value'];
    }
  }

  const inputs = block['inputs'];
  if (!isObject(inputs)) return null;
  const filenameInput = inputs['FILENAME'];
  if (typeof filenameInput === 'string') return filenameInput;
  if (!isObject(filenameInput)) return null;

  const valueBlock = isObject(filenameInput['block']) ? filenameInput['block'] : filenameInput['shadow'];
  if (!isObject(valueBlock)) return null;
  const valueFields = valueBlock['fields'];
  if (!isObject(valueFields)) return null;
  const text = valueFields['TEXT'];
  if (typeof text === 'string') return text;
  if (isObject(text) && typeof text['value'] === 'string') return text['value'];
  return null;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
