'use strict';

function normalizeLeaseId(value) {
  return String(value || '').trim();
}

function normalizeOwnerId(value) {
  const ownerId = Number(value);
  return Number.isInteger(ownerId) && ownerId > 0 ? ownerId : 0;
}

function ensureOwners(session) {
  if (!(session?.owners instanceof Map)) {
    session.owners = new Map();
  }
  return session.owners;
}

function ownerIds(session) {
  const ids = [];
  const seen = new Set();
  for (const owner of ensureOwners(session).values()) {
    if (seen.has(owner.ownerId)) continue;
    seen.add(owner.ownerId);
    ids.push(owner.ownerId);
  }
  return ids;
}

function hasOwnerId(session, ownerId) {
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  return !!normalizedOwnerId
    && ownerIds(session).includes(normalizedOwnerId);
}

function setMessageControllerOwner(session, ownerId) {
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  if (!session || !hasOwnerId(session, normalizedOwnerId)) {
    return false;
  }
  session.messageControllerOwnerId = normalizedOwnerId;
  return true;
}

function electMessageControllerOwner(session) {
  if (!session) return 0;
  if (hasOwnerId(session, session.messageControllerOwnerId)) {
    return session.messageControllerOwnerId;
  }
  const [nextOwnerId = 0] = ownerIds(session);
  session.messageControllerOwnerId = nextOwnerId;
  return nextOwnerId;
}

function ownerKey(ownerId, leaseId) {
  return `${normalizeOwnerId(ownerId)}:${normalizeLeaseId(leaseId)}`;
}

function acquireOwner(session, ownerId, leaseId) {
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  const normalizedLeaseId = normalizeLeaseId(leaseId);
  if (!session || !normalizedOwnerId || !normalizedLeaseId) {
    return { success: false, reason: 'invalid-owner' };
  }

  const owners = ensureOwners(session);
  const key = ownerKey(normalizedOwnerId, normalizedLeaseId);
  const added = !owners.has(key);
  owners.set(key, {
    ownerId: normalizedOwnerId,
    leaseId: normalizedLeaseId,
    acquiredAt: Date.now(),
  });
  electMessageControllerOwner(session);
  return { success: true, added, refCount: owners.size, key };
}

function releaseOwner(session, ownerId, leaseId) {
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  const normalizedLeaseId = normalizeLeaseId(leaseId);
  if (!session || !normalizedOwnerId) {
    return { success: false, reason: 'invalid-owner', released: 0, refCount: ownerCount(session) };
  }

  const owners = ensureOwners(session);
  let released = 0;
  if (normalizedLeaseId) {
    released = owners.delete(ownerKey(normalizedOwnerId, normalizedLeaseId)) ? 1 : 0;
  } else {
    for (const [key, owner] of owners.entries()) {
      if (owner.ownerId !== normalizedOwnerId) continue;
      owners.delete(key);
      released += 1;
    }
  }
  electMessageControllerOwner(session);
  return {
    success: released > 0,
    reason: released > 0 ? undefined : 'lease-not-found',
    released,
    refCount: owners.size,
  };
}

function releaseOwnerFromSessions(sessions, ownerId) {
  const released = [];
  for (const [toolId, session] of sessions.entries()) {
    const result = releaseOwner(session, ownerId, '');
    if (result.released > 0) {
      released.push({ toolId, session, ...result });
    }
  }
  return released;
}

function hasOwner(session, ownerId, leaseId) {
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  const normalizedLeaseId = normalizeLeaseId(leaseId);
  if (!session || !normalizedOwnerId || !normalizedLeaseId) {
    return false;
  }
  return ensureOwners(session).has(ownerKey(normalizedOwnerId, normalizedLeaseId));
}

function authorizeMessagePortSend(session, ownerId, payload = {}) {
  if (!session?.messagePort) {
    return { success: false, reason: 'message-port-unavailable' };
  }
  const streamId = String(payload.streamId || '').trim();
  if (!streamId || streamId !== session.streamId) {
    return {
      success: false,
      reason: 'stale-session',
      currentStreamId: session.streamId,
    };
  }
  if (!hasOwner(session, ownerId, payload.leaseId)) {
    return { success: false, reason: 'owner-not-authorized' };
  }
  if (electMessageControllerOwner(session) !== normalizeOwnerId(ownerId)) {
    return { success: false, reason: 'message-controller-not-authorized' };
  }
  return { success: true, streamId };
}

function ownerCount(session) {
  return session?.owners instanceof Map ? session.owners.size : 0;
}

function classifyRegistration(existing, candidateStreamId, existingAlive) {
  if (!existing) return 'register';
  if (String(existing.streamId || '') === String(candidateStreamId || '')) return 'same-stream';
  return existingAlive ? 'reuse-existing' : 'replace-stale';
}

module.exports = {
  acquireOwner,
  authorizeMessagePortSend,
  classifyRegistration,
  electMessageControllerOwner,
  hasOwner,
  hasOwnerId,
  ownerCount,
  releaseOwner,
  releaseOwnerFromSessions,
  setMessageControllerOwner,
};
