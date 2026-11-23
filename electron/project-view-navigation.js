'use strict';

const stale = () => ({ ok: false, code: 'PROJECT_VIEW_CHANGED', error: 'The original view reservation is no longer current.' });
const MAX_RETIREMENTS = 512;

/** Main owns the navigation transition. File snapshots only authorize release of
 * the captured native record. Each renderer request also has a separate owner. */
function createProjectViewNavigation(lock) {
  const reservations = new Map();
  const retirements = new Map();
  let selected;
  const normalize = path => path ? lock.normalizeProjectPathLoose(path) : null;
  const exact = (entry, request) => entry?.requestId === request.requestId
    && entry.rendererGeneration === request.rendererGeneration
    && entry.sourceProject === normalize(request.sourceProject)
    && entry.projectPath === normalize(request.projectPath);

  function selectLegacy(project, generation) {
    const projectPath = normalize(project);
    if (selected?.projectPath === projectPath && (!selected.rendererGeneration || selected.rendererGeneration === generation)) return;
    // An explicit legacy acquisition of this path now owns its native record.
    reservations.delete(projectPath);
    selected = { projectPath };
  }

  function reserve(request, options) {
    const projectPath = normalize(request.projectPath), sourceProject = normalize(request.sourceProject);
    if (exact(retirements.get(request.requestId), request)) return stale();
    let prior = reservations.get(projectPath);
    if (prior?.retired) {
      release(prior, true);
      prior = reservations.get(projectPath);
    }
    if (exact(prior, request)) return observe(request);
    if (!selected || selected.projectPath !== sourceProject || !projectPath || projectPath === sourceProject || prior) return stale();
    let sourceSnapshot;
    try { sourceSnapshot = lock.readViewLockSnapshot(sourceProject); }
    catch { return stale(); }
    if (sourceSnapshot?.owner?.pid !== process.pid) return stale();
    const result = lock.tryAcquireLock(projectPath, options);
    if (!result.ok) return result;
    let snapshot;
    try { snapshot = lock.readViewLockSnapshot(projectPath); }
    catch { return stale(); }
    if (snapshot?.owner?.pid !== process.pid) return stale();
    reservations.set(projectPath, {
      requestId: request.requestId, rendererGeneration: request.rendererGeneration,
      projectPath, sourceProject, source: selected, sourceSnapshot, snapshot,
    });
    return { ...result, reserved: true };
  }

  function promote(request) {
    const entry = reservations.get(normalize(request.projectPath));
    if (!exact(entry, request) || selected !== entry.source) return stale();
    const released = lock.handoffViewLock(entry.sourceProject, entry.sourceSnapshot, entry.projectPath, entry.snapshot);
    if (!released.ok) return released;
    reservations.delete(entry.sourceProject);
    selected = entry;
    entry.source = undefined;
    entry.sourceSnapshot = undefined;
    return { ok: true, selected: true, normalizedPath: entry.projectPath };
  }

  function observe(request) {
    const entry = reservations.get(normalize(request.projectPath));
    if (!exact(entry, request)) return stale();
    return { ok: true, reserved: true, selected: selected === entry, normalizedPath: entry.projectPath };
  }

  function release(request, pendingOnly = false) {
    const entry = reservations.get(normalize(request.projectPath));
    if (pendingOnly && selected !== entry) {
      const { requestId, rendererGeneration } = request;
      retirements.set(requestId, { requestId, rendererGeneration, sourceProject: normalize(request.sourceProject),
        projectPath: normalize(request.projectPath) });
      if (retirements.size > MAX_RETIREMENTS) retirements.delete(retirements.keys().next().value);
    }
    if (!exact(entry, request) || pendingOnly && selected === entry) return { ok: true };
    const result = lock.releaseLock(entry.projectPath, entry.snapshot);
    if (result.ok || result.code === 'PROJECT_VIEW_CHANGED') {
      reservations.delete(entry.projectPath);
      if (selected === entry) selected = undefined;
    }
    return result;
  }

  function retireGeneration(generation) {
    for (const entry of reservations.values()) {
      if (entry !== selected && entry.rendererGeneration === generation) {
        entry.retired = true;
        release(entry, true);
      }
    }
    for (const [id, entry] of retirements) {
      if (entry.rendererGeneration === generation) retirements.delete(id);
    }
  }

  return {
    reserve, promote, observe, release, retireGeneration, selectLegacy,
    currentProject: () => selected?.projectPath ?? null,
    isClaimed: project => reservations.has(normalize(project)),
  };
}

module.exports = { createProjectViewNavigation };
