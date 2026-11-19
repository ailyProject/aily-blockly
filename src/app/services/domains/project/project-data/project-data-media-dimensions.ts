import { MAX_U8G2_BITMAP_DIMENSION } from './project-data-xbm';

type DimensionsInput = { width?: unknown; height?: unknown };

export const DEFAULT_U8G2_BITMAP_SIZE = { width: 64, height: 128 } as const;
export const DEFAULT_TFT_MEDIA_SIZE = { width: 160, height: 120 } as const;
export const MAX_TFT_MEDIA_DIMENSION = 480;

export function u8g2BitmapSize(value?: DimensionsInput, config?: DimensionsInput) {
  const dimension = (value: unknown) => {
    const parsed = Number(value);
    return Math.min(MAX_U8G2_BITMAP_DIMENSION, Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : 1));
  };
  return {
    width: dimension(value?.width ?? config?.width ?? DEFAULT_U8G2_BITMAP_SIZE.width),
    height: dimension(value?.height ?? config?.height ?? DEFAULT_U8G2_BITMAP_SIZE.height),
  };
}

export function tftMediaSize(value?: DimensionsInput, fallback: Readonly<{ width: number; height: number }> = DEFAULT_TFT_MEDIA_SIZE) {
  const dimension = (value: unknown, defaultValue: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(MAX_TFT_MEDIA_DIMENSION, Math.max(1, Math.floor(parsed))) : defaultValue;
  };
  return { width: dimension(value?.width, fallback.width), height: dimension(value?.height, fallback.height) };
}
