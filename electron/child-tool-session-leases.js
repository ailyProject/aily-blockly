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

function ownerCount(session) {
  return session?.owners instanceof Map ? session.owners.size : 0;
}

module.exports = {
  acquireOwner,
  ownerCount,
  releaseOwner,
  releaseOwnerFromSessions,
};
