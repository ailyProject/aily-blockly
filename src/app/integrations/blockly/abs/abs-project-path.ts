/** A canonical Agent path may name the same directory as a host-opened alias.
 * Do not rewrite the generation scope: it remains owned by the open project. */
export async function sameAbsProjectDirectory(left: string, right: string,
  realpath: ((path: string) => Promise<string>) | undefined, windows: boolean): Promise<boolean> {
  const normalize = (path: string) => {
    const value = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return windows ? value.toLowerCase() : value;
  };
  if (!left || !right) return false;
  if (normalize(left) === normalize(right)) return true;
  if (!realpath) return false;
  try {
    const [a, b] = await Promise.all([realpath(left), realpath(right)]);
    return !!a && !!b && normalize(a) === normalize(b);
  } catch { return false; }
}
