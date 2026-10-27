/** Expand a variant path with the same bounded SDK property rules as the Worker. */
export function expandVariantProperty(value: unknown, properties: Record<string, unknown>): string {
  let result = String(value || '');
  for (let pass = 0; pass < 16; pass++) {
    if (result.length > 4096) throw new Error('Variant property expansion exceeds its limit');
    const next = result.replace(/\{([^{}]+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(properties, name) ? String(properties[name]) : match);
    if (next === result) break;
    result = next;
  }
  if (result.length > 4096 || /[{}]/.test(result)) throw new Error('Variant property remains unresolved');
  return result;
}

export function resolveVariantPaths(baseProperties: Record<string, unknown>, optionProperties: Record<string, unknown> = {}) {
  const properties = { ...baseProperties, ...optionProperties };
  return {
    variant: expandVariantProperty(properties['build.variant'], properties),
    header: expandVariantProperty(properties['build.variant_h'] || 'variant_generic.h', properties),
  };
}
