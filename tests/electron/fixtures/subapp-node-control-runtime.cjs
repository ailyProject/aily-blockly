'use strict';
// A registered protocol fixture, not an application/domain implementation.
const records = new Map();
const identity = frame => ({ version: 1, runtimeId: frame.runtimeId, connectionId: frame.connectionId, requestId: frame.requestId });
const send = frame => new Promise((resolve, reject) => process.send(frame, error => error ? reject(error) : resolve()));
process.on('message', async frame => {
    if (frame.type === 'aily-subapp-node-control.attach') {
        records.set(frame.connectionId, { pending: new Map(), context: frame.context });
        await send({ type: 'aily-subapp-node-control.attached', ...identity(frame), ok: true });
    } else if (frame.type === 'aily-subapp-node-control.request') {
        const record = records.get(frame.connectionId); if (!record) return;
        if (frame.payload.hold) record.pending.set(frame.requestId, frame);
        else await send({ type: 'aily-subapp-node-control.result', ...identity(frame), ok: true, result: frame.payload });
    } else if (frame.type === 'aily-subapp-node-control.cancel') {
        // Cancellation admission alone never settles an accepted operation.
    } else if (frame.type === 'aily-subapp-node-control.detach') {
        const record = records.get(frame.connectionId);
        if (record) {
            for (const pending of record.pending.values()) await send({ type: 'aily-subapp-node-control.result', ...identity(pending),
                ok: false, errorCode: 'FIXTURE_CANCELLED', error: 'Actual fixture pending work drained' });
            record.pending.clear(); records.delete(frame.connectionId);
        }
        await send({ type: 'aily-subapp-node-control.detached', ...identity(frame), ok: true });
    }
});
process.once('disconnect', () => process.exit(records.size ? 1 : 0));
