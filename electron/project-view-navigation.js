'use strict';

const stale = () => ({ ok: false, code: 'PROJECT_VIEW_CHANGED', error: 'The original view reservation is no longer current.' });
const MAX_RETIREMENTS = 512;

/** Main owns the navigation transition and binds it to the exact native leases.
 * Each renderer request also has a separate owner. */
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
    // An explicit selection can adopt the main process's existing lease.
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
    const sourceLease = lock.captureHeldView(sourceProject);
    if (!sourceLease) return stale();
    const result = lock.tryAcquireLock(projectPath, options);
    if (!result.ok) return result;
    reservations.set(projectPath, {
      requestId: request.requestId, rendererGeneration: request.rendererGeneration,
      projectPath, sourceProject, source: selected, sourceLease, targetLease: { viewToken: result.viewToken },
    });
    return { ...result, reserved: true };
  }

  function promote(request) {
    const entry = reservations.get(normalize(request.projectPath));
    if (!exact(entry, request) || selected !== entry.source) return stale();
    const released = lock.handoffViewLock(entry.sourceProject, entry.sourceLease, entry.projectPath, entry.targetLease);
    if (!released.ok) return released;
    reservations.delete(entry.sourceProject);
    selected = entry;
    entry.source = undefined;
    entry.sourceLease = undefined;
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
    const result = lock.releaseLock(entry.projectPath, entry.targetLease);
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
