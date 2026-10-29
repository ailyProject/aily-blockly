'use strict';

// E2E and repair instances must not replace the user's application integration.
// This policy only governs OS registration; resource preparation still runs normally.
function resolveOsIntegrationPolicy({ e2e = false, repairBootstrap = false, platform = process.platform } = {}) {
  const enabled = !e2e && !repairBootstrap;
  return Object.freeze({
    registerProtocols: enabled,
    registerWindowsUserTasks: enabled && platform === 'win32',
  });
}

module.exports = { resolveOsIntegrationPolicy };
