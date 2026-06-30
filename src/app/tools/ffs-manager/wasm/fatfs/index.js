export const FAT_MOUNT = "/fatfs";
const INITIAL_LIST_BUFFER = 4096;
const DEFAULT_BLOCK_SIZE = 4096;
const DEFAULT_BLOCK_COUNT = 128;
const FATFS_ERR_INVAL = -1;
const FATFS_ERR_NOSPC = -3;
export class FatFSError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "FatFSError";
    }
}
export async function createFatFSFromImage(image, options = {}) {
    console.info("[fatfs-wasm] createFatFSFromImage() starting");
    const wasmURL = options.wasmURL ?? new URL("./fatfs.wasm", import.meta.url);
    const exports = await instantiateFatFSModule(wasmURL);
    const bytes = asBinaryUint8Array(image);
    const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    if (blockSize !== DEFAULT_BLOCK_SIZE) {
        throw new Error(`blockSize must be ${DEFAULT_BLOCK_SIZE}`);
    }
    if (options.blockCount && options.blockCount * blockSize !== bytes.length) {
        throw new Error("Image size must equal blockSize * blockCount");
    }
    const heap = new Uint8Array(exports.memory.buffer);
    const imagePtr = exports.malloc(bytes.length || 1);
    if (!imagePtr) {
        throw new FatFSError("Failed to allocate WebAssembly memory", FATFS_ERR_NOSPC);
    }
    try {
        heap.set(bytes, imagePtr);
        const initResult = exports.fatfsjs_init_from_image(imagePtr, bytes.length);
        if (initResult < 0) {
            throw new FatFSError("Failed to initialize FAT16 image", initResult);
        }
    }
    finally {
        exports.free(imagePtr);
    }
    console.info("[fatfs-wasm] Filesystem initialized from image");
    return new FatFSClient(exports);
}
export async function createFatFS(options = {}) {
    console.info("[fatfs-wasm] createFatFS() starting", options);
    const wasmURL = options.wasmURL ?? new URL("./fatfs.wasm", import.meta.url);
    const exports = await instantiateFatFSModule(wasmURL);
    const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    const blockCount = options.blockCount ?? DEFAULT_BLOCK_COUNT;
    if (blockSize !== DEFAULT_BLOCK_SIZE) {
        throw new Error(`blockSize must be ${DEFAULT_BLOCK_SIZE}`);
    }
    if (!Number.isFinite(blockCount) || blockCount <= 0) {
        throw new Error("blockCount must be a positive integer");
    }
    const initResult = exports.fatfsjs_init(blockSize, blockCount);
    if (initResult < 0) {
        throw new FatFSError("Failed to initialize FatFS", initResult);
    }
    if (options.formatOnInit) {
        const formatResult = exports.fatfsjs_format();
        if (formatResult < 0) {
            throw new FatFSError("Failed to format filesystem", formatResult);
        }
    }
    console.info("[fatfs-wasm] Filesystem initialized");
    return new FatFSClient(exports);
}
class FatFSClient {
    constructor(exports) {
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.listBufferSize = INITIAL_LIST_BUFFER;
        this.exports = exports;
        this.heapU8 = new Uint8Array(this.exports.memory.buffer);
    }
    list(path = FAT_MOUNT) {
        const normalized = normalizeMountPath(path);
        const basePath = normalized;
        const pathPtr = this.allocString(normalized);
        let capacity = this.listBufferSize;
        try {
            while (true) {
                const ptr = this.alloc(capacity);
                try {
                    const used = this.exports.fatfsjs_list(pathPtr, ptr, capacity);
                    if (used === FATFS_ERR_NOSPC) {
                        this.listBufferSize = capacity * 2;
                        capacity = this.listBufferSize;
                        continue;
                    }
                    this.assertOk(used, "list files");
                    if (used === 0) {
                        return [];
                    }
                    const payload = this.decoder.decode(this.heapU8.subarray(ptr, ptr + used));
                    return parseListPayload(payload).map((entry) => ({
                        ...entry,
                        path: joinListPath(basePath, entry.path),
                    }));
                }
                finally {
                    this.exports.free(ptr);
                }
            }
        }
        finally {
            this.exports.free(pathPtr);
        }
    }
    readFile(path) {
        const normalized = normalizeMountPath(path);
        if (normalized === FAT_MOUNT) {
            throw new FatFSError("Path must point to a file", FATFS_ERR_INVAL);
        }
        const pathPtr = this.allocString(normalized);
        try {
            const size = this.exports.fatfsjs_file_size(pathPtr);
            this.assertOk(size, `stat file "${normalized}"`);
            if (size === 0) {
                return new Uint8Array();
            }
            const dataPtr = this.alloc(size);
            try {
                const read = this.exports.fatfsjs_read_file(pathPtr, dataPtr, size);
                this.assertOk(read, `read file "${normalized}"`);
                return this.heapU8.slice(dataPtr, dataPtr + size);
            }
            finally {
                this.exports.free(dataPtr);
            }
        }
        finally {
            this.exports.free(pathPtr);
        }
    }
    toImage() {
        const size = this.exports.fatfsjs_storage_size();
        if (size === 0) {
            return new Uint8Array();
        }
        const ptr = this.alloc(size);
        try {
            const copied = this.exports.fatfsjs_export_image(ptr, size);
            this.assertOk(copied, "export filesystem image");
            return this.heapU8.slice(ptr, ptr + size);
        }
        finally {
            this.exports.free(ptr);
        }
    }
    getUsage() {
        const capacityBytes = this.exports.fatfsjs_storage_size();
        const entries = this.list(FAT_MOUNT);
        const usedBytes = entries.reduce((acc, entry) => (entry.type === "file" ? acc + entry.size : acc), 0);
        const freeBytes = capacityBytes > usedBytes ? capacityBytes - usedBytes : 0;
        return {
            capacityBytes,
            usedBytes,
            freeBytes,
        };
    }
    format() {
        const result = this.exports.fatfsjs_format();
        this.assertOk(result, "format filesystem");
    }
    writeFile(path, data) {
        const normalized = normalizeMountPath(path);
        if (normalized === FAT_MOUNT) {
            throw new FatFSError("Path must point to a file", FATFS_ERR_INVAL);
        }
        const payload = asUint8Array(data, this.encoder);
        const pathPtr = this.allocString(normalized);
        const dataPtr = payload.length ? this.alloc(payload.length) : 0;
        try {
            if (payload.length > 0) {
                this.heapU8.set(payload, dataPtr);
            }
            const result = this.exports.fatfsjs_write_file(pathPtr, dataPtr, payload.length);
            this.assertOk(result, `write file "${normalized}"`);
        }
        finally {
            if (dataPtr) {
                this.exports.free(dataPtr);
            }
            this.exports.free(pathPtr);
        }
    }
    deleteFile(path) {
        const normalized = normalizeMountPath(path);
        if (normalized === FAT_MOUNT) {
            throw new FatFSError("Path must point to a file", FATFS_ERR_INVAL);
        }
        const pathPtr = this.allocString(normalized);
        try {
            const result = this.exports.fatfsjs_delete_file(pathPtr);
            this.assertOk(result, `delete file "${normalized}"`);
        }
        finally {
            this.exports.free(pathPtr);
        }
    }
    mkdir(path) {
        const normalized = normalizeMountPath(path);
        if (normalized === FAT_MOUNT) {
            return;
        }
        const pathPtr = this.allocString(normalized);
        try {
            const result = this.exports.fatfsjs_mkdir(pathPtr);
            this.assertOk(result, `mkdir "${normalized}"`);
        }
        finally {
            this.exports.free(pathPtr);
        }
    }
    rename(oldPath, newPath) {
        const from = normalizeMountPath(oldPath);
        const to = normalizeMountPath(newPath);
        const fromPtr = this.allocString(from);
        const toPtr = this.allocString(to);
        try {
            const result = this.exports.fatfsjs_rename(fromPtr, toPtr);
            this.assertOk(result, `rename "${from}" -> "${to}"`);
        }
        finally {
            this.exports.free(fromPtr);
            this.exports.free(toPtr);
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
            throw new FatFSError("Failed to allocate WebAssembly memory", FATFS_ERR_NOSPC);
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
            throw new FatFSError(`Unable to ${action}`, code);
        }
    }
}
async function instantiateFatFSModule(input) {
    const source = resolveWasmURL(input);
    console.info("[fatfs-wasm] Fetching wasm from", source.href);
    const wasmContext = { memory: null };
    const imports = createDefaultImports(wasmContext);
    let response = await fetch(source);
    if (!response.ok) {
        throw new Error(`Unable to fetch FATFS wasm from ${response.url}`);
    }
    console.info("[fatfs-wasm] Fetch complete, status", response.status);
    if ("instantiateStreaming" in WebAssembly && typeof WebAssembly.instantiateStreaming === "function") {
        try {
            console.info("[fatfs-wasm] Attempting instantiateStreaming");
            const streaming = await WebAssembly.instantiateStreaming(response, imports);
            wasmContext.memory = getExportedMemory(streaming.instance.exports);
            console.info("[fatfs-wasm] instantiateStreaming succeeded");
            return streaming.instance.exports;
        }
        catch (error) {
            console.warn("Unable to instantiate FATFS wasm via streaming, retrying with arrayBuffer()", error);
            response = await fetch(source);
            if (!response.ok) {
                throw new Error(`Unable to fetch FATFS wasm from ${response.url}`);
            }
            console.info("[fatfs-wasm] Fallback fetch complete, status", response.status);
        }
    }
    console.info("[fatfs-wasm] Instantiating from ArrayBuffer fallback");
    const bytes = await response.arrayBuffer();
    const instance = await WebAssembly.instantiate(bytes, imports);
    wasmContext.memory = getExportedMemory(instance.instance.exports);
    console.info("[fatfs-wasm] instantiate(bytes) succeeded");
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
        const [rawPath, rawSize, rawType] = line.split("\t");
        return {
            path: rawPath ?? "",
            size: Number(rawSize ?? "0") || 0,
            type: rawType === "d" ? "dir" : "file",
        };
    });
}
function normalizeMountPath(input) {
    const raw = (input ?? "").trim();
    if (!raw || raw === "/") {
        return FAT_MOUNT;
    }
    const normalized = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    const collapsed = normalized.endsWith("/") && normalized !== "/" ? normalized.slice(0, -1) : normalized;
    const lower = collapsed.toLowerCase();
    if (lower.startsWith(FAT_MOUNT)) {
        const rest = collapsed.slice(FAT_MOUNT.length);
        return rest ? `${FAT_MOUNT}${rest}` : FAT_MOUNT;
    }
    if (collapsed.startsWith("/")) {
        return `${FAT_MOUNT}${collapsed}`;
    }
    return `${FAT_MOUNT}/${collapsed}`;
}
function joinListPath(basePath, entryPath) {
    const base = basePath.replace(/\/+$/, "");
    if (!entryPath || entryPath === "/") {
        return base || FAT_MOUNT;
    }
    const trimmed = entryPath.replace(/^\/+/, "");
    return base === FAT_MOUNT ? `${FAT_MOUNT}/${trimmed}` : `${base}/${trimmed}`;
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
            console.info(`[fatfs-wasm::fd_write fd=${fd}] ${text}`);
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
