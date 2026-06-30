const DEFAULT_PAGE_SIZE = 256;
const DEFAULT_BLOCK_SIZE = 4096;
const DEFAULT_BLOCK_COUNT = 256;
const DEFAULT_FD_COUNT = 16;
const DEFAULT_CACHE_PAGES = 64;
const INITIAL_LIST_BUFFER = 4096;
const SPIFFS_CAN_FIT_SUCCESS = 1;
export var SpiffsErrorCode;
(function (SpiffsErrorCode) {
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_OK"] = 0] = "SPIFFS_OK";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_NOT_MOUNTED"] = -10000] = "SPIFFS_ERR_NOT_MOUNTED";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_FULL"] = -10001] = "SPIFFS_ERR_FULL";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_NOT_FOUND"] = -10002] = "SPIFFS_ERR_NOT_FOUND";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_END_OF_OBJECT"] = -10003] = "SPIFFS_ERR_END_OF_OBJECT";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_DELETED"] = -10004] = "SPIFFS_ERR_DELETED";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_NOT_FINALIZED"] = -10005] = "SPIFFS_ERR_NOT_FINALIZED";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_NOT_INDEX"] = -10006] = "SPIFFS_ERR_NOT_INDEX";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_OUT_OF_FILE_DESCS"] = -10007] = "SPIFFS_ERR_OUT_OF_FILE_DESCS";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_FILE_CLOSED"] = -10008] = "SPIFFS_ERR_FILE_CLOSED";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_FILE_DELETED"] = -10009] = "SPIFFS_ERR_FILE_DELETED";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_BAD_DESCRIPTOR"] = -10010] = "SPIFFS_ERR_BAD_DESCRIPTOR";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_IS_INDEX"] = -10011] = "SPIFFS_ERR_IS_INDEX";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_IS_FREE"] = -10012] = "SPIFFS_ERR_IS_FREE";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_INDEX_SPAN_MISMATCH"] = -10013] = "SPIFFS_ERR_INDEX_SPAN_MISMATCH";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_DATA_SPAN_MISMATCH"] = -10014] = "SPIFFS_ERR_DATA_SPAN_MISMATCH";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_INDEX_REF_FREE"] = -10015] = "SPIFFS_ERR_INDEX_REF_FREE";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_INDEX_REF_LU"] = -10016] = "SPIFFS_ERR_INDEX_REF_LU";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_INDEX_REF_INVALID"] = -10017] = "SPIFFS_ERR_INDEX_REF_INVALID";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_INDEX_FREE"] = -10018] = "SPIFFS_ERR_INDEX_FREE";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_INDEX_LU"] = -10019] = "SPIFFS_ERR_INDEX_LU";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_INDEX_INVALID"] = -10020] = "SPIFFS_ERR_INDEX_INVALID";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_NOT_WRITABLE"] = -10021] = "SPIFFS_ERR_NOT_WRITABLE";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_NOT_READABLE"] = -10022] = "SPIFFS_ERR_NOT_READABLE";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_CONFLICTING_NAME"] = -10023] = "SPIFFS_ERR_CONFLICTING_NAME";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_NOT_CONFIGURED"] = -10024] = "SPIFFS_ERR_NOT_CONFIGURED";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_NOT_A_FS"] = -10025] = "SPIFFS_ERR_NOT_A_FS";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_MOUNTED"] = -10026] = "SPIFFS_ERR_MOUNTED";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_ERASE_FAIL"] = -10027] = "SPIFFS_ERR_ERASE_FAIL";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_MAGIC_NOT_POSSIBLE"] = -10028] = "SPIFFS_ERR_MAGIC_NOT_POSSIBLE";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_NO_DELETED_BLOCKS"] = -10029] = "SPIFFS_ERR_NO_DELETED_BLOCKS";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_FILE_EXISTS"] = -10030] = "SPIFFS_ERR_FILE_EXISTS";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_NOT_A_FILE"] = -10031] = "SPIFFS_ERR_NOT_A_FILE";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_RO_NOT_IMPL"] = -10032] = "SPIFFS_ERR_RO_NOT_IMPL";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_RO_ABORTED_OPERATION"] = -10033] = "SPIFFS_ERR_RO_ABORTED_OPERATION";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_PROBE_TOO_FEW_BLOCKS"] = -10034] = "SPIFFS_ERR_PROBE_TOO_FEW_BLOCKS";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_PROBE_NOT_A_FS"] = -10035] = "SPIFFS_ERR_PROBE_NOT_A_FS";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_NAME_TOO_LONG"] = -10036] = "SPIFFS_ERR_NAME_TOO_LONG";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_IX_MAP_UNMAPPED"] = -10037] = "SPIFFS_ERR_IX_MAP_UNMAPPED";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_IX_MAP_MAPPED"] = -10038] = "SPIFFS_ERR_IX_MAP_MAPPED";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_IX_MAP_BAD_RANGE"] = -10039] = "SPIFFS_ERR_IX_MAP_BAD_RANGE";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_SEEK_BOUNDS"] = -10040] = "SPIFFS_ERR_SEEK_BOUNDS";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_INTERNAL"] = -10050] = "SPIFFS_ERR_INTERNAL";
    SpiffsErrorCode[SpiffsErrorCode["SPIFFS_ERR_TEST"] = -10100] = "SPIFFS_ERR_TEST";
})(SpiffsErrorCode || (SpiffsErrorCode = {}));
export const SpiffsErrorMessages = {
    [SpiffsErrorCode.SPIFFS_OK]: "Operation succeeded",
    [SpiffsErrorCode.SPIFFS_ERR_NOT_MOUNTED]: "Filesystem not mounted",
    [SpiffsErrorCode.SPIFFS_ERR_FULL]: "No space left on device",
    [SpiffsErrorCode.SPIFFS_ERR_NOT_FOUND]: "Object not found",
    [SpiffsErrorCode.SPIFFS_ERR_END_OF_OBJECT]: "End of object reached",
    [SpiffsErrorCode.SPIFFS_ERR_DELETED]: "Object already deleted",
    [SpiffsErrorCode.SPIFFS_ERR_NOT_FINALIZED]: "Object not finalized",
    [SpiffsErrorCode.SPIFFS_ERR_NOT_INDEX]: "Entry is not an index",
    [SpiffsErrorCode.SPIFFS_ERR_OUT_OF_FILE_DESCS]: "Out of file descriptors",
    [SpiffsErrorCode.SPIFFS_ERR_FILE_CLOSED]: "File handle already closed",
    [SpiffsErrorCode.SPIFFS_ERR_FILE_DELETED]: "File already deleted",
    [SpiffsErrorCode.SPIFFS_ERR_BAD_DESCRIPTOR]: "Invalid file descriptor",
    [SpiffsErrorCode.SPIFFS_ERR_IS_INDEX]: "Entry is an index",
    [SpiffsErrorCode.SPIFFS_ERR_IS_FREE]: "Entry is free",
    [SpiffsErrorCode.SPIFFS_ERR_INDEX_SPAN_MISMATCH]: "Index span mismatch",
    [SpiffsErrorCode.SPIFFS_ERR_DATA_SPAN_MISMATCH]: "Data span mismatch",
    [SpiffsErrorCode.SPIFFS_ERR_INDEX_REF_FREE]: "Index reference points at free entry",
    [SpiffsErrorCode.SPIFFS_ERR_INDEX_REF_LU]: "Index lookup error",
    [SpiffsErrorCode.SPIFFS_ERR_INDEX_REF_INVALID]: "Invalid index reference",
    [SpiffsErrorCode.SPIFFS_ERR_INDEX_FREE]: "Index entry free",
    [SpiffsErrorCode.SPIFFS_ERR_INDEX_LU]: "Index lookup failed",
    [SpiffsErrorCode.SPIFFS_ERR_INDEX_INVALID]: "Invalid index entry",
    [SpiffsErrorCode.SPIFFS_ERR_NOT_WRITABLE]: "Filesystem is read-only",
    [SpiffsErrorCode.SPIFFS_ERR_NOT_READABLE]: "Filesystem is write-only",
    [SpiffsErrorCode.SPIFFS_ERR_CONFLICTING_NAME]: "Name already exists",
    [SpiffsErrorCode.SPIFFS_ERR_NOT_CONFIGURED]: "Filesystem not configured",
    [SpiffsErrorCode.SPIFFS_ERR_NOT_A_FS]: "Not a SPIFFS volume",
    [SpiffsErrorCode.SPIFFS_ERR_MOUNTED]: "Volume already mounted",
    [SpiffsErrorCode.SPIFFS_ERR_ERASE_FAIL]: "Flash erase failed",
    [SpiffsErrorCode.SPIFFS_ERR_MAGIC_NOT_POSSIBLE]: "Magic not possible for partition",
    [SpiffsErrorCode.SPIFFS_ERR_NO_DELETED_BLOCKS]: "No deleted blocks available",
    [SpiffsErrorCode.SPIFFS_ERR_FILE_EXISTS]: "File already exists",
    [SpiffsErrorCode.SPIFFS_ERR_NOT_A_FILE]: "Target is not a file",
    [SpiffsErrorCode.SPIFFS_ERR_RO_NOT_IMPL]: "Read-only mode not implemented",
    [SpiffsErrorCode.SPIFFS_ERR_RO_ABORTED_OPERATION]: "Operation aborted in read-only mode",
    [SpiffsErrorCode.SPIFFS_ERR_PROBE_TOO_FEW_BLOCKS]: "Probe found too few blocks",
    [SpiffsErrorCode.SPIFFS_ERR_PROBE_NOT_A_FS]: "Probe did not find a filesystem",
    [SpiffsErrorCode.SPIFFS_ERR_NAME_TOO_LONG]: "Name exceeds maximum length",
    [SpiffsErrorCode.SPIFFS_ERR_IX_MAP_UNMAPPED]: "Index map unmapped",
    [SpiffsErrorCode.SPIFFS_ERR_IX_MAP_MAPPED]: "Index map already mapped",
    [SpiffsErrorCode.SPIFFS_ERR_IX_MAP_BAD_RANGE]: "Index map range invalid",
    [SpiffsErrorCode.SPIFFS_ERR_SEEK_BOUNDS]: "Seek bounds exceeded",
    [SpiffsErrorCode.SPIFFS_ERR_INTERNAL]: "Internal error",
    [SpiffsErrorCode.SPIFFS_ERR_TEST]: "Test error",
};
export class SpiffsError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "SpiffsError";
        this.description =
            SpiffsErrorMessages[code] ?? "Unknown SPIFFS error";
    }
    static descriptionForCode(code) {
        return SpiffsErrorMessages[code] ?? "Unknown SPIFFS error";
    }
}
export async function createSpiffs(options = {}) {
    console.info("[spiffs-wasm] createSpiffs() starting", options);
    const wasmURL = options.wasmURL ?? new URL("./spiffs.wasm", import.meta.url);
    const exports = await instantiateSpiffsModule(wasmURL);
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    const blockCount = options.blockCount ?? DEFAULT_BLOCK_COUNT;
    validateSpiffsLayout(pageSize, blockSize, blockCount);
    const fdCount = options.fdCount ?? DEFAULT_FD_COUNT;
    const cachePages = options.cachePages ?? DEFAULT_CACHE_PAGES;
    const initResult = exports.spiffsjs_init(pageSize, blockSize, blockCount, fdCount, cachePages);
    console.info("[spiffs-wasm] spiffsjs_init returned", initResult);
    if (initResult < 0) {
        throw new SpiffsError("Failed to initialize SPIFFS", initResult);
    }
    if (options.formatOnInit) {
        const formatResult = exports.spiffsjs_format();
        console.info("[spiffs-wasm] spiffsjs_format returned", formatResult);
        if (formatResult < 0) {
            throw new SpiffsError("Failed to format SPIFFS volume", formatResult);
        }
    }
    const client = new SpiffsClient(exports);
    console.info("[spiffs-wasm] Filesystem initialized");
    return client;
}
export async function createSpiffsFromImage(image, options = {}) {
    console.info("[spiffs-wasm] createSpiffsFromImage() starting");
    const wasmURL = options.wasmURL ?? new URL("./spiffs.wasm", import.meta.url);
    const exports = await instantiateSpiffsModule(wasmURL);
    const bytes = asBinaryUint8Array(image);
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    const blockCount = options.blockCount ??
        Math.max(1, Math.floor(bytes.length / Math.max(blockSize, 1)));
    validateSpiffsLayout(pageSize, blockSize, blockCount);
    if (blockCount * blockSize !== bytes.length) {
        throw new Error("Image size must equal blockSize * blockCount");
    }
    const fdCount = options.fdCount ?? DEFAULT_FD_COUNT;
    const cachePages = options.cachePages ?? DEFAULT_CACHE_PAGES;
    const heap = new Uint8Array(exports.memory.buffer);
    const ptr = exports.malloc(bytes.length || 1);
    if (!ptr) {
        throw new SpiffsError("Failed to allocate WebAssembly memory", -1 // mimic not enough core
        );
    }
    try {
        heap.set(bytes, ptr);
        const initResult = exports.spiffsjs_init_from_image(pageSize, blockSize, blockCount, fdCount, cachePages, ptr, bytes.length);
        if (initResult < 0) {
            throw new SpiffsError("Failed to initialize SPIFFS from image", initResult);
        }
    }
    finally {
        exports.free(ptr);
    }
    const client = new SpiffsClient(exports);
    console.info("[spiffs-wasm] Filesystem initialized from image");
    return client;
}
class SpiffsClient {
    constructor(exports) {
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.listBufferSize = INITIAL_LIST_BUFFER;
        this.exports = exports;
        this.heapU8 = new Uint8Array(this.exports.memory.buffer);
    }
    async list() {
        let capacity = this.listBufferSize;
        while (true) {
            const ptr = this.alloc(capacity);
            try {
                const used = this.exports.spiffsjs_list(ptr, capacity);
                if (used < 0) {
                    this.assertOk(used, "list files");
                }
                if (used === 0) {
                    return [];
                }
                const payload = this.decoder.decode(this.heapU8.subarray(ptr, ptr + used));
                return parseListPayload(payload);
            }
            finally {
                this.exports.free(ptr);
            }
        }
    }
    async read(name) {
        const normalized = normalizePath(name);
        const candidates = getFsPathCandidates(normalized);
        let chosenPath = null;
        let fileSize = null;
        let lastError = 0;
        for (const candidate of candidates) {
            const pathPtr = this.allocString(candidate);
            try {
                const size = this.exports.spiffsjs_file_size(pathPtr);
                if (size >= 0) {
                    chosenPath = candidate;
                    fileSize = size;
                    break;
                }
                lastError = size;
            }
            finally {
                this.exports.free(pathPtr);
            }
        }
        if (fileSize === null || chosenPath === null) {
            this.assertOk(lastError, `stat file "${normalized}"`);
            return new Uint8Array();
        }
        if (fileSize === 0) {
            return new Uint8Array();
        }
        const dataPtr = this.alloc(fileSize);
        const pathPtr = this.allocString(chosenPath);
        try {
            const read = this.exports.spiffsjs_read_file(pathPtr, dataPtr, fileSize);
            this.assertOk(read, `read file "${normalized}"`);
            return this.heapU8.slice(dataPtr, dataPtr + fileSize);
        }
        finally {
            this.exports.free(dataPtr);
            this.exports.free(pathPtr);
        }
    }
    async write(name, data) {
        const normalized = normalizePath(name);
        const fsPath = normalizeForFs(normalized);
        const payload = asUint8Array(data, this.encoder);
        const pathPtr = this.allocString(fsPath);
        const dataPtr = payload.length ? this.alloc(payload.length) : 0;
        try {
            if (payload.length > 0) {
                this.heapU8.set(payload, dataPtr);
            }
            const result = this.exports.spiffsjs_write_file(pathPtr, dataPtr, payload.length);
            this.assertOk(result, `write file "${normalized}"`);
        }
        finally {
            if (dataPtr) {
                this.exports.free(dataPtr);
            }
            this.exports.free(pathPtr);
        }
    }
    async remove(name) {
        const normalized = normalizePath(name);
        const fsPath = normalizeForFs(normalized);
        const pathPtr = this.allocString(fsPath);
        try {
            const result = this.exports.spiffsjs_remove_file(pathPtr);
            this.assertOk(result, `delete file "${normalized}"`);
        }
        finally {
            this.exports.free(pathPtr);
        }
    }
    async format() {
        const result = this.exports.spiffsjs_format();
        this.assertOk(result, "format filesystem");
    }
    async toImage() {
        const size = this.exports.spiffsjs_storage_size();
        if (size === 0) {
            return new Uint8Array();
        }
        const ptr = this.alloc(size);
        try {
            const copied = this.exports.spiffsjs_export_image(ptr, size);
            this.assertOk(copied, "export filesystem image");
            return this.heapU8.slice(ptr, ptr + size);
        }
        finally {
            this.exports.free(ptr);
        }
    }
    async getUsage() {
        const ptr = this.alloc(12);
        try {
            const result = this.exports.spiffsjs_get_usage(ptr);
            this.assertOk(result, "get usage");
            const view = new DataView(this.heapU8.buffer, ptr, 12);
            return {
                capacityBytes: view.getUint32(0, true),
                usedBytes: view.getUint32(4, true),
                freeBytes: view.getUint32(8, true),
            };
        }
        finally {
            this.exports.free(ptr);
        }
    }
    canFit(name, dataLength) {
        const normalized = normalizePath(name);
        const fsPath = normalizeForFs(normalized);
        const pathPtr = this.allocString(fsPath);
        try {
            const result = this.exports.spiffsjs_can_fit(pathPtr, dataLength);
            if (result >= 0) {
                return result === SPIFFS_CAN_FIT_SUCCESS;
            }
            this.assertOk(result, `check space for "${normalized}"`);
            return false;
        }
        finally {
            this.exports.free(pathPtr);
        }
    }
    refreshHeap() {
        if (this.heapU8.buffer !== this.exports.memory.buffer) {
            this.heapU8 = new Uint8Array(this.exports.memory.buffer);
        }
    }
    alloc(size) {
        if (size <= 0) {
            return 0;
        }
        const ptr = this.exports.malloc(size);
        if (!ptr) {
            throw new SpiffsError("Failed to allocate WebAssembly memory", -1);
        }
        this.refreshHeap();
        return ptr;
    }
    allocString(value) {
        const encoded = this.encoder.encode(value);
        const ptr = this.alloc(encoded.length + 1);
        this.heapU8.set(encoded, ptr);
        this.heapU8[ptr + encoded.length] = 0;
        return ptr;
    }
    assertOk(code, action) {
        if (code < 0) {
            throw new SpiffsError(`Unable to ${action}`, code);
        }
    }
}
async function instantiateSpiffsModule(input) {
    const source = resolveWasmURL(input);
    console.info("[spiffs-wasm] Fetching wasm from", source.href);
    const wasmContext = { memory: null };
    const imports = createDefaultImports(wasmContext);
    let response = await fetch(source);
    if (!response.ok) {
        throw new Error(`Unable to fetch SPIFFS wasm from ${response.url}`);
    }
    console.info("[spiffs-wasm] Fetch complete, status", response.status);
    if ("instantiateStreaming" in WebAssembly && typeof WebAssembly.instantiateStreaming === "function") {
        try {
            console.info("[spiffs-wasm] Attempting instantiateStreaming");
            const streaming = await WebAssembly.instantiateStreaming(response, imports);
            wasmContext.memory = getExportedMemory(streaming.instance.exports);
            console.info("[spiffs-wasm] instantiateStreaming succeeded");
            return streaming.instance.exports;
        }
        catch (error) {
            console.warn("Unable to instantiate SPIFFS wasm via streaming, retrying with arrayBuffer()", error);
            response = await fetch(source);
            if (!response.ok) {
                throw new Error(`Unable to fetch SPIFFS wasm from ${response.url}`);
            }
            console.info("[spiffs-wasm] Fallback fetch complete, status", response.status);
        }
    }
    console.info("[spiffs-wasm] Instantiating from ArrayBuffer fallback");
    const bytes = await response.arrayBuffer();
    const instance = await WebAssembly.instantiate(bytes, imports);
    wasmContext.memory = getExportedMemory(instance.instance.exports);
    console.info("[spiffs-wasm] instantiate(bytes) succeeded");
    return instance.instance.exports;
}
function parseListPayload(payload) {
    if (!payload) {
        return [];
    }
    return payload
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
        const [rawName, rawType, rawSize] = line.split("\t");
        return {
            name: rawName ?? "",
            type: rawType === "dir" ? "dir" : "file",
            size: Number(rawSize ?? "0") || 0,
        };
    });
}
function normalizePath(input) {
    const value = input.trim().replace(/\\/g, "/");
    const collapsed = value.replace(/\/{2,}/g, "/");
    const cleaned = collapsed.endsWith("/") && collapsed !== "/"
        ? collapsed.slice(0, -1)
        : collapsed;
    if (!cleaned || cleaned === "/") {
        throw new Error('Path must point to a file (e.g. "docs/readme.txt")');
    }
    return cleaned;
}
function normalizeForFs(value) {
    const trimmed = value.replace(/^\/+/, "");
    if (!trimmed) {
        throw new Error('Path must point to a file (e.g. "/readme.txt")');
    }
    const segments = trimmed.split("/").filter((segment) => segment.length > 0);
    if (segments.length !== 1) {
        throw new Error("SPIFFS paths must refer to a single file name (no directories)");
    }
    return "/" + segments[0];
}
function getFsPathCandidates(normalized) {
    const candidates = [normalized];
    const trimmed = normalized.replace(/^\/+/, "");
    if (trimmed && trimmed !== normalized) {
        candidates.push(trimmed);
    }
    return candidates;
}
function validateSpiffsLayout(pageSize, blockSize, blockCount) {
    if (!Number.isFinite(pageSize) || pageSize <= 0) {
        throw new Error("pageSize must be a positive integer");
    }
    if (!Number.isFinite(blockSize) || blockSize <= 0) {
        throw new Error("blockSize must be a positive integer");
    }
    if (blockSize % pageSize !== 0) {
        throw new Error("blockSize must be a multiple of pageSize");
    }
    if (!Number.isFinite(blockCount) || blockCount <= 0) {
        throw new Error("blockCount must be a positive integer");
    }
}
function asUint8Array(source, encoder) {
    if (typeof source === "string") {
        return encoder.encode(source);
    }
    if (source instanceof Uint8Array) {
        return source;
    }
    if (source instanceof ArrayBuffer) {
        return new Uint8Array(source);
    }
    throw new Error("Unsupported file payload type");
}
function asBinaryUint8Array(source) {
    if (source instanceof Uint8Array) {
        return source;
    }
    if (source instanceof ArrayBuffer) {
        return new Uint8Array(source);
    }
    throw new Error("Expected Uint8Array or ArrayBuffer for filesystem image");
}
function resolveWasmURL(input) {
    if (input instanceof URL) {
        return input;
    }
    const locationLike = typeof globalThis !== "undefined" && "location" in globalThis
        ? globalThis.location
        : undefined;
    const baseHref = locationLike?.href;
    try {
        return baseHref ? new URL(input, baseHref) : new URL(input);
    }
    catch (error) {
        throw new Error(`Unable to resolve wasm URL from "${input}": ${String(error)}`);
    }
}
function createDefaultImports(context) {
    const noop = () => { };
    const ok = () => 0;
    return {
        env: {
            emscripten_notify_memory_growth: noop,
        },
        wasi_snapshot_preview1: {
            fd_close: ok,
            fd_seek: ok,
            fd_write: (fd, iov, iovcnt, pnum) => handleFdWrite(context, fd, iov, iovcnt, pnum),
        },
    };
}
function handleFdWrite(context, fd, iov, iovcnt, pnum) {
    const memory = context.memory;
    if (!memory) {
        return 0;
    }
    const view = new DataView(memory.buffer);
    let total = 0;
    for (let i = 0; i < iovcnt; i++) {
        const base = iov + i * 8;
        const ptr = view.getUint32(base, true);
        const len = view.getUint32(base + 4, true);
        total += len;
        if (fd === 1 || fd === 2) {
            const bytes = new Uint8Array(memory.buffer, ptr, len);
            const text = new TextDecoder().decode(bytes);
            console.info(`[spiffs-wasm::fd_write fd=${fd}] ${text}`);
        }
    }
    view.setUint32(pnum, total, true);
    return 0;
}
function getExportedMemory(exports) {
    for (const value of Object.values(exports)) {
        if (value instanceof WebAssembly.Memory) {
            return value;
        }
    }
    return null;
}
