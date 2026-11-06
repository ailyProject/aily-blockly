'use strict';

// Presentation of an already validated, trusted Host selection only. Address,
// DNS and transport policy stays in the shared Node driver/ledger. Nothing here
// accepts a browser destination, performs DNS or imports an OS network API.
const selections = new WeakSet();
function data(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Expected plain Host selection data');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !descriptors[key] || !('value' in descriptors[key]))) throw new TypeError('Host selection fields changed');
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function text(value, max) {
    if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Invalid Host selection label');
    return value;
}
function list(value, allowed, min = 0) {
    if (!Array.isArray(value) || value.length < min || value.length > 2) throw new TypeError('Invalid selected transport metadata');
    const descriptors = Object.getOwnPropertyDescriptors(value), out = [];
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('Invalid selected transport metadata');
    for (let i = 0; i < value.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !('value' in descriptor) || !allowed.includes(descriptor.value) || out.includes(descriptor.value)) throw new TypeError('Invalid selected transport metadata');
        out.push(descriptor.value);
    }
    return Object.freeze(out);
}
function identifier(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new TypeError('Invalid opaque endpoint identity');
    return value;
}

/** The normal Main composition must derive these rows from the same validated
 * fixed endpoint configuration used to construct its inert shared Node driver.
 * `detail` is display text, never an executable address or connection policy.
 * A real normal Host UI supplies showChooser; absent configuration/UI yields
 * null. No test switch, auto-selection or consent persistence is provided.
 * showChooser must resolve its actual dialog result and honour cancellation;
 * abandoning its Promise is not confirmed chooser cleanup. */
function createMainNetworkEndpointSelection({ resources, showChooser } = {}) {
    if (resources === undefined || showChooser === undefined) return null;
    if (!Array.isArray(resources) || resources.length < 1 || resources.length > 16 || typeof showChooser !== 'function') throw new TypeError('Normal Host selection ports are incomplete');
    const descriptors = Object.getOwnPropertyDescriptors(resources), rows = [];
    if (Reflect.ownKeys(resources).length !== resources.length + 1) throw new TypeError('Invalid Host endpoint rows');
    for (let i = 0; i < resources.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !('value' in descriptor)) throw new TypeError('Invalid Host endpoint rows');
        const value = data(descriptor.value, ['endpointId', 'label', 'detail', 'transports', 'recordTypes']);
        const row = Object.freeze({ endpointId: identifier(value.endpointId), label: text(value.label, 96), detail: text(value.detail, 2048),
            transports: list(value.transports, ['tcp', 'udp'], 1), recordTypes: list(value.recordTypes, ['A', 'AAAA']) });
        if (rows.some(old => old.endpointId === row.endpointId)) throw new TypeError('Duplicate Host endpoint identity');
        rows.push(row);
    }
    const fixed = Object.freeze(rows);
    const selection = Object.freeze({
        endpointIds: Object.freeze(fixed.map(row => row.endpointId)),
        async chooseEndpoints(input, signal, requireCurrentAuthority) {
            if (!signal || typeof signal.throwIfAborted !== 'function' || typeof requireCurrentAuthority !== 'function') throw new TypeError('Original Host chooser authority is required');
            requireCurrentAuthority();
            if (signal.aborted) return Object.freeze({ outcome: 'cancelled' });
            // The shared provider supplies its own fixed driver choices. A
            // display configuration cannot silently name another endpoint.
            if (!Array.isArray(input.choices) || input.choices.length !== fixed.length) throw new TypeError('Host endpoint table changed');
            for (const row of fixed) {
                const candidate = input.choices.find(choice => choice.endpointId === row.endpointId);
                if (!candidate || candidate.transports.join('\0') !== row.transports.join('\0')
                    || candidate.recordTypes.join('\0') !== row.recordTypes.join('\0')) throw new TypeError('Host endpoint table changed');
            }
            const result = await showChooser(Object.freeze({ title: '允许当前仿真访问本机网络目的地',
                message: '请选择一个固定目的地；此权限仅属于当前仿真会话。',
                choices: Object.freeze(fixed.map(row => Object.freeze({ endpointId: row.endpointId, label: row.label, detail: row.detail }))),
                initialSelection: null }), signal);
            requireCurrentAuthority();
            if (signal.aborted) return Object.freeze({ outcome: 'cancelled' });
            const value = data(result, result && Object.hasOwn(result, 'endpointId') ? ['outcome', 'endpointId'] : ['outcome']);
            if (value.outcome === 'cancelled') return Object.freeze({ outcome: 'cancelled' });
            if (value.outcome !== 'selected' || !fixed.some(row => row.endpointId === value.endpointId)) throw new TypeError('Host chooser selected an unknown endpoint');
            return Object.freeze({ outcome: 'selected', resourceIds: Object.freeze([value.endpointId]) });
        },
    });
    selections.add(selection);
    return selection;
}
function isMainNetworkEndpointSelection(value) { return !!value && selections.has(value); }
module.exports = { createMainNetworkEndpointSelection, isMainNetworkEndpointSelection };
