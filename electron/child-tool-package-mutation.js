async function quiesceChildToolPackageMutation({
  toolId,
  action = 'update',
  sessions,
  ownerCount,
  cancelRelease,
  stopSession,
  pendingMessages,
  onChanged,
}) {
  const session = sessions.get(toolId);
  if (!session) return { status: 'idle', toolId, action };
  const refCount = ownerCount(session);
  if (refCount > 0) {
    const error = new Error(
      `Subapp ${toolId} is in use by ${refCount} active owner(s). Close its surfaces before ${action}.`,
    );
    error.code = 'SUBAPP_UPDATE_IN_USE';
    error.toolId = toolId;
    error.refCount = refCount;
    throw error;
  }
  cancelRelease(session);
  await stopSession(session);
  pendingMessages.delete(session.streamId);
  sessions.delete(toolId);
  onChanged();
  return { status: 'stopped', toolId, action };
}

module.exports = {
  quiesceChildToolPackageMutation,
};
