import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';

export interface NativeRequestFootprint {
  /** Existing UTF-16 JSON character units, with small descriptors in place of binary views. */
  textCharacters: number;
  /** Structured clone copies each complete backing store, not only the visible slice. */
  backingBytes: number;
  backingBuffers: number;
  units: number;
}

const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const sharedBufferLength = typeof SharedArrayBuffer === 'undefined' ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get!;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const dataBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;

const invalidBacking = () => new AbsSyncError('ABS_NATIVE_RESOURCE_INVALID', 'Native candidate binary backing store cannot be measured safely.',
  undefined, [], { reason: 'invalid-binary-backing', hint: 'Preserve the resource and ABS draft. Native resources require a detached ArrayBuffer snapshot with a finite backing size.' });
const sharedBacking = () => new AbsSyncError('ABS_NATIVE_RESOURCE_INVALID', 'Native candidate resources cannot share mutable memory.', undefined, [], {
  reason: 'shared-mutable-resource', hint: 'Preserve the resource and ABS draft. Native resources require a detached immutable snapshot, not SharedArrayBuffer or a shared-memory view.',
});

function backingLength(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (sharedBufferLength) {
    let shared = false;
    try { Reflect.apply(sharedBufferLength, value, []); shared = true; } catch { /* Not a branded shared store. */ }
    if (shared) throw sharedBacking();
  }
  try { return Reflect.apply(arrayBufferLength, value, []); } catch { /* Not a branded ArrayBuffer. */ }
  if (!sharedBufferLength) {
    // A receiver may not expose SharedArrayBuffer while a foreign Realm does.
    // The native constructor brands its input without consulting caller tags,
    // prototypes or properties and allocates no backing memory for this view.
    let shared = false;
    try { new DataView(value as ArrayBuffer, 0, 0); shared = true; } catch { /* Not a buffer. */ }
    if (shared) throw sharedBacking();
  }
  return undefined;
}

/** Budget estimate only; it never rewrites, transfers or resolves request data. */
export function nativeRequestFootprint(value: unknown): NativeRequestFootprint {
  const buffers = new Map<ArrayBuffer, number>();
  let backingBytes = 0;
  const bufferId = (buffer: ArrayBufferLike, length = backingLength(buffer)): number => {
    if (!Number.isSafeInteger(length) || length! < 0) throw invalidBacking();
    const store = buffer as ArrayBuffer;
    const existing = buffers.get(store);
    if (existing !== undefined) return existing;
    const id = buffers.size;
    buffers.set(store, id);
    backingBytes += length!;
    if (!Number.isSafeInteger(backingBytes)) throw invalidBacking();
    return id;
  };
  const json = JSON.stringify(value, (_key, member) => {
    if (ArrayBuffer.isView(member)) {
      let buffer: ArrayBufferLike, offset: number, length: number;
      try {
        buffer = Reflect.apply(typedBuffer, member, []);
        offset = Reflect.apply(typedOffset, member, []); length = Reflect.apply(typedLength, member, []);
      } catch {
        try {
          buffer = Reflect.apply(dataBuffer, member, []);
          offset = Reflect.apply(dataOffset, member, []); length = Reflect.apply(dataLength, member, []);
        } catch { throw invalidBacking(); }
      }
      return { $nativeBinaryBudget: [bufferId(buffer), offset, length] };
    }
    const length = backingLength(member);
    if (length !== undefined) return { $nativeBinaryBudget: [bufferId(member, length)] };
    return member;
  });
  const textCharacters = json?.length ?? 0;
  const units = textCharacters + backingBytes;
  if (!Number.isSafeInteger(units)) throw invalidBacking();
  return { textCharacters, backingBytes, backingBuffers: buffers.size, units };
}
