// Both protocol generations share the same in-flight slot for a bound Coder frame.
const active = new WeakMap<Window, AbortController>();
export function beginCodeRequest(frame: Window, controller: AbortController): () => void {
  active.get(frame)?.abort();
  active.set(frame, controller);
  return () => { if (active.get(frame) === controller) active.delete(frame); };
}
