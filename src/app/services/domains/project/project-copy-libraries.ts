/** Save As observes effective dependencies, not just the last saved manifest.
 * This snapshot never saves/discards the source manager or installs packages. */
export async function captureProjectCopyLibraries(project: string) {
  const read = async () => {
    const state = await window['libraryDependencies']?.status(project);
    if (!state || typeof state.dirty !== 'boolean' || typeof state.busy !== 'boolean'
      || !state.manifest || typeof state.manifest !== 'object' || Array.isArray(state.manifest)) {
      throw new Error('Project copy requires current library-manager facts; no source changes were saved or discarded.');
    }
    if (state.busy) throw new Error('Library changes are still running; the source was retained. Retry copying after that operation finishes.');
    return JSON.stringify(state.manifest);
  };
  const manifestText = await read();
  return { manifestText, assertCurrent: async () => {
    if (await read() !== manifestText) throw new Error('Effective library dependencies changed during project copy; retain the source and retry with a fresh snapshot.');
  } };
}
