const DEFAULT_AUTO_PRESET_ID = 'auto';
const AUTO_MODEL_DISCOUNT_FACTOR = 0.9;

function truncateToSingleDecimal(value: number): number {
  return Math.trunc(value * 10) / 10;
}

function formatTruncatedBillingMultiplierLabel(multiplier: number): string {
  const truncatedMultiplier = truncateToSingleDecimal(multiplier);
  const normalizedMultiplier = Number.isInteger(truncatedMultiplier)
    ? truncatedMultiplier.toFixed(0)
    : truncatedMultiplier.toFixed(1);
  return `${normalizedMultiplier}x`;
}

export function isDefaultAutoPresetIdentifier(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === DEFAULT_AUTO_PRESET_ID;
}

export function isAutoPresetIdentifier(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue === DEFAULT_AUTO_PRESET_ID || normalizedValue.startsWith(`${DEFAULT_AUTO_PRESET_ID}-`);
}

export function isDefaultAutoPresetSelected(
  model: { presetId?: unknown; model?: unknown } | null | undefined,
): boolean {
  return isDefaultAutoPresetIdentifier(model?.presetId) || isDefaultAutoPresetIdentifier(model?.model);
}

export function isAutoPresetSelected(
  model: { presetId?: unknown; model?: unknown } | null | undefined,
): boolean {
  return isAutoPresetIdentifier(model?.presetId) || isAutoPresetIdentifier(model?.model);
}

export function formatBillingMultiplierLabel(multiplier: number): string {
  const normalizedMultiplier = Number.isInteger(multiplier)
    ? multiplier.toFixed(0)
    : multiplier.toFixed(multiplier * 10 === Math.trunc(multiplier * 10) ? 1 : 2);
  return `${normalizedMultiplier}x`;
}

export function parseBillingMultiplierLabel(label: string | null | undefined): number | undefined {
  if (typeof label !== 'string') {
    return undefined;
  }

  const match = label.trim().match(/^(?:x\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*x)$/i);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1] ?? match[2]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function applyAutoDiscountToBillingLabel(label: string | null | undefined): string | undefined {
  if (typeof label !== 'string' || !label.trim()) {
    return undefined;
  }

  const normalizedLabel = label.trim();

  const discountMatch = normalizedLabel.match(/^(\d+(?:\.\d+)?)%\s*discount$/i);
  if (discountMatch) {
    const discountPercent = Number(discountMatch[1]);
    if (Number.isFinite(discountPercent) && discountPercent >= 0 && discountPercent < 100) {
      return formatTruncatedBillingMultiplierLabel((100 - discountPercent) / 100);
    }
  }

  const multiplier = parseBillingMultiplierLabel(normalizedLabel);
  if (multiplier === undefined) {
    return normalizedLabel;
  }

  return formatTruncatedBillingMultiplierLabel(multiplier * AUTO_MODEL_DISCOUNT_FACTOR);
}