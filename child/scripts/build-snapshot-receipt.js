'use strict';

/** Report the captured compiler source separately from the ABI retained by the editor. */
function buildSnapshotReceipt(capture, buildRequestId, inputDigest, savedComparison, savedAbiHash) {
    if (capture?.mode !== 'blockly' || !/^[a-f0-9]{64}$/.test(capture.sourceSha256 ?? '')
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(buildRequestId ?? '')
        || !/^[a-f0-9]{64}$/.test(inputDigest ?? '')) return undefined;
    const workspace = capture.workspace;
    const verifiedAbiHash = /^sha256:[a-f0-9]{64}$/.test(savedAbiHash ?? '') ? savedAbiHash : undefined;
    const savedMatch = workspace && verifiedAbiHash && verifiedAbiHash === savedComparison?.savedAbiHash
        && ['matched', 'different'].includes(savedComparison.savedMatch) ? savedComparison.savedMatch : 'unknown';
    return { version: 1, buildRequestId, inputDigest, sourceSha256: capture.sourceSha256, savedMatch,
        ...(workspace ? { documentSha256: workspace.documentSha256, workspaceRevision: workspace.revision } : {}),
        ...(verifiedAbiHash ? { savedAbiHash: verifiedAbiHash } : {}) };
}

module.exports = { buildSnapshotReceipt };
