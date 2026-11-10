'use strict';

// Main-only compilation permission. This is deliberately not runtime acceptance.
const PROFILE = 'esp32-classic-spp-ahc2-v2';
const PROVIDER = 'aily.esp32-spp-vhci-v2';
const NATIVE_PROFILE = 'esp32-classic-p15-aio-ble-v1';
const NATIVE_PROFILES = [NATIVE_PROFILE, 'esp32-classic-p15-aio-ble-learned-mmio-v1'];
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...fields].sort().join(',');

function readCompilationProfiles(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length !== 1) throw new Error('Invalid Browser compilation profiles');
    const item = value[0];
    if (!exact(item, ['schemaVersion', 'profile', 'provider', 'nativeProfile', 'runtimeAcceptance'])
        || item.schemaVersion !== 1 || item.profile !== PROFILE || item.provider !== PROVIDER
        || !NATIVE_PROFILES.includes(item.nativeProfile) || item.runtimeAcceptance !== false) {
        throw new Error('Unsupported Browser compilation profile');
    }
    return Object.freeze([Object.freeze({ schemaVersion: 1, profile: PROFILE, provider: PROVIDER,
        nativeProfile: item.nativeProfile, runtimeAcceptance: false })]);
}

/** Never accepts a renderer-supplied package, owner, execution or release selector.
 * Capture the actual original registered owner and immutable Main release; every
 * use retains that record and refuses a successor at the same runtime/path. */
function captureSimulatorCompilationBinding(registry, sender) {
    try {
        const runtime = registry.resolveRuntime('simulator', sender.id);
        if (!runtime) return null;
        const original = registry.broker.resolveNetworkOwner({ runtimeId: runtime.streamId,
            ownerId: sender.id, toolId: 'simulator' });
        // Supervisor guards expose a frozen stream/origin projection, not the
        // registered session object. Keep that object's identity pinned below.
        if (!original || original.guard.runtime?.streamId !== runtime.streamId) return null;
        const host = registry.host, state = host.runtimes.get(runtime.streamId), source = state?.source;
        if (!source?.compilationProfiles || readCompilationProfiles(source.compilationProfiles)[0].profile !== PROFILE) return null;
        const release = host.configuredReleaseForSource?.(source);
        if (!release || new URL(release.resourceBaseUrl).protocol !== 'https:') return null;
        const config = runtime.hostInfo?.runtimeConfig;
        const assertCurrent = () => {
            original.assertCurrent();
            if (sender.isDestroyed() || registry.resolveRuntime('simulator', sender.id) !== runtime
                || original.lease.ownerId !== sender.id || original.lease.runtimeId !== runtime.streamId
                || original.lease.executionId !== state.executionId || host.runtimes.get(runtime.streamId) !== state
                || state.source !== source || !host.isCurrent(original.lease)
                || host.configuredReleaseForSource(source) !== release
                || release.manifest.packageIdentity.name !== source.packageName
                || release.manifest.packageIdentity.version !== source.version
                || state.resourceBaseUrl !== release.resourceBaseUrl || state.resourceIdentity !== release.releaseId
                || state.resourceSha256?.[source.entry] !== source.sha256
                || release.manifest.files.filter(file => file.path === source.entry && file.sha256 === source.sha256).length !== 1
                || runtime.hostInfo?.runtimeConfig !== config || config?.id !== 'simulator'
                || require('./subapp-browser-execution-source').readBrowserExecutionSource(config).identity !== source.identity) {
                throw new Error('Original Simulator compilation binding is unavailable');
            }
        };
        assertCurrent();
        return Object.freeze({ profile: PROFILE, provider: PROVIDER, assertCurrent });
    } catch { return null; }
}

module.exports = { PROFILE, PROVIDER, NATIVE_PROFILE, readCompilationProfiles, captureSimulatorCompilationBinding };
