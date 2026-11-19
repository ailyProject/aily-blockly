'use strict';

/** Permission/query failures are not evidence that a native owner exited. */
function getProcessState(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown';
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : 'unknown'; }
}

module.exports = { getProcessState };
