import type { AilyDataRef } from './project-data.types';

export const MAX_U8G2_BITMAP_DIMENSION = 256;

export interface U8g2BitmapValue {
  readonly schemaVersion: 1;
  readonly encoding: 'xbm-lsb-row-v1';
  readonly width: number;
  readonly height: number;
  readonly bitmap: AilyDataRef | null;
}

/** XBM pads each row to whole bytes, starting at the least significant bit. */
export function packXbmBitmap(width: number, height: number, isSet: (x: number, y: number) => boolean): Uint8Array {
  const stride = Math.ceil(width / 8);
  const bytes = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isSet(x, y)) bytes[y * stride + (x >> 3)] |= 1 << (x & 7);
    }
  }
  return bytes;
}
