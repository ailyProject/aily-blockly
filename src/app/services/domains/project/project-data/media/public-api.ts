/** Media geometry shared by the renderer and browser workers. */
export type MediaFit = 'contain' | 'stretch';
export interface MediaSize {
  width: number;
  height: number;
}
export interface MediaRect extends MediaSize {
  x: number;
  y: number;
}

export function fitMediaRect(source: MediaSize, target: MediaSize, fit: MediaFit): MediaRect {
  if (fit === 'stretch') return { x: 0, y: 0, ...target };
  const scale = Math.min(target.width / source.width, target.height / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  return { x: Math.floor((target.width - width) / 2), y: Math.floor((target.height - height) / 2), width, height };
}
