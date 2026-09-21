import { readAbsSingleQuotedToken } from '@shared/public-api';
import { AbsSyncError } from './abs-state';

/** Field semantics are supplied by definitions/runtime, never guessed from names. */
export interface AbsFieldDefinition {
  type: string;
  options?: readonly (readonly [unknown, string | number | boolean])[];
  min?: number;
  max?: number;
  precision?: number;
  valueType?: 'string' | 'number' | 'boolean' | 'json';
  /** Supplied by a model-aware adapter, never inferred from the field name/value. */
  symbol?: {
    kind: 'variable' | 'procedure';
    storage: 'id' | 'name' | 'variable-state';
    allowedTypes?: readonly string[];
  };
}

export interface AbsFieldToken {
  raw: string;
  value: unknown;
  quoted: boolean;
  reference?: 'variable';
  omitted?: true;
}

export function readAbsFieldToken(raw: string): AbsFieldToken {
  raw = raw.trim();
  if (!raw) throw new Error('Empty field value.');
  if (raw[0] === '$') {
    const name = raw.slice(1);
    const value = name.startsWith('"') ? JSON.parse(name) : name;
    if (typeof value !== 'string' || !value || (!name.startsWith('"') && !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name))) {
      throw new Error('Variable references require $name or $"display name".');
    }
    return { raw, value, quoted: false, reference: 'variable' };
  }
  if (raw[0] === "'") {
    const token = readAbsSingleQuotedToken(raw, 0);
    if (token.end !== raw.length) throw new Error('Unexpected input after quoted field.');
    return { raw, value: token.value, quoted: true };
  }
  if (raw[0] === '"' || raw[0] === '{' || raw[0] === '[') {
    return { raw, value: JSON.parse(raw), quoted: raw[0] === '"' };
  }
  if (raw === 'true' || raw === 'false' || raw === 'null' || /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)) {
    const value = JSON.parse(raw);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite field number.');
    return { raw, value, quoted: false };
  }
  return { raw, value: raw, quoted: false };
}

export function resolveAbsFieldValue(token: AbsFieldToken, definition?: AbsFieldDefinition): unknown {
  if (token.omitted && !(definition?.type === 'field_dropdown' && definition.options?.some(option => option[1] === ''))) {
    throw new Error('An omitted argument is only valid for a dropdown with an empty option.');
  }
  const { value, quoted } = token;
  if (token.reference) throw new Error('A variable reference requires a variable field or a value input. Quote literal text.');
  if (!definition) return value;
  if (definition.type === 'field_dropdown' && Array.isArray(definition.options)) {
    const allowed = definition.options.map(option => option[1]);
    if (allowed.includes(value as never)) return value;
    // README pin/enumeration literals are often numeric but Blockly persists
    // string keys. Match the exact lexeme, never a numeric approximation/label.
    if (!quoted && typeof value === 'number' && allowed.includes(token.raw)) return token.raw;
    if (!quoted && typeof value === 'boolean') {
      const candidates = allowed.filter(option => option === String(value) || option === String(value).toUpperCase());
      if (candidates.length === 1) return candidates[0];
    }
    throw new AbsSyncError('ABS_FIELD_OPTION_INVALID',
      `Invalid dropdown value ${JSON.stringify(value)?.slice(0, 256)}; allowed: ${JSON.stringify(allowed.slice(0, 64))}.`, undefined, [],
      { received: value as string, allowedValues: allowed,
        hint: 'Choose an exact allowed value, not a display label or a pin number from another board. Do not guess numeric GPIO mappings.' });
  }
  if (definition.type === 'field_checkbox') {
    if (value === true || value === 'TRUE') return 'TRUE';
    if (value === false || value === 'FALSE') return 'FALSE';
    throw new Error('Checkbox requires true/false or "TRUE"/"FALSE".');
  }
  if (definition.type === 'field_number') {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(number)
      || (definition.min !== undefined && number < definition.min)
      || (definition.max !== undefined && number > definition.max)) {
      throw new Error('Number is not finite or is outside the field range.');
    }
    if (definition.precision > 0) {
      const steps = number / definition.precision;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) throw new Error('Number would be rounded by the field.');
    }
    return number;
  }
  if (definition.type === 'field_input' || definition.valueType === 'string') {
    // The original lexeme preserves leading zeros in handwritten unquoted text.
    return quoted ? value : typeof value === 'object' ? value : token.raw;
  }
  return value;
}

/** Only equivalences verified against Blockly serialization, never String(value). */
export function normalizeAbsSerializedField(value: unknown, definition?: AbsFieldDefinition): unknown {
  if (definition?.type === 'field_checkbox') {
    if (value === true || value === 'TRUE') return true;
    if (value === false || value === 'FALSE') return false;
  }
  if (definition?.symbol?.kind === 'variable' && definition.symbol.storage === 'variable-state'
    && value && typeof value === 'object' && !Array.isArray(value)) {
    const { name, type, ...state } = value as Record<string, unknown>;
    // Model name/type are compared in the workspace table; unknown members remain significant.
    return state;
  }
  return value;
}
