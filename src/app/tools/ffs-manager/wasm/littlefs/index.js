/**
 * LittleFS WebAssembly Bindings for ESPConnect
 * 
 * Provides TypeScript-first API for LittleFS with disk version control.
 * Supports DISK_VERSION_2_0 to prevent automatic migration of older filesystems.
 * 
 * ESP-IDF Compatible Configuration:
 * - LFS_NAME_MAX=64 (filename length)
 * - LFS_ATTR_MAX=4 (metadata for timestamps)
 * - LFS_MULTIVERSION enabled
 */

// Import Emscripten-generated module loader (converted to ES module)
import createLittleFSModule from './littlefs.js';

const DEFAULT_BLOCK_SIZE = 4096;
const DEFAULT_BLOCK_COUNT = 256;
const DEFAULT_LOOKAHEAD_SIZE = 32;
const LFS_ERR_NOSPC = -28;

/**
 * Maximum filename length (ESP-IDF default)
 */
export const LFS_NAME_MAX = 64;

/**
 * LittleFS disk version 2.0 (0x00020000)
 * Use this for maximum compatibility with older implementations.
 */
export const DISK_VERSION_2_0 = 0x00020000;

/**
 * LittleFS disk version 2.1 (0x00020001)
 * Latest version with additional features.
 */
export const DISK_VERSION_2_1 = 0x00020001;

/**
 * Format disk version as human-readable string (e.g., "2.0", "2.1")
 */
export function formatDiskVersion(version) {
    const major = (version >> 16) & 0xffff;
    const minor = version & 0xffff;
    return `${major}.${minor}`;
}

export class LittleFSError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "LittleFSError";
    }
}

function createModuleConfig(wasmURL) {
    const wasmURLStr = wasmURL instanceof URL ? wasmURL.href : wasmURL;
    
    return {
        locateFile: (path) => {
            if (path.endsWith('.wasm')) {
                console.info("[littlefs-wasm] locateFile:", path, "->", wasmURLStr);
                return wasmURLStr;
            }
            return path;
        }
    };
}

/**
 * Create a new LittleFS instance
 * @param {LittleFSOptions} options 
 * @returns {Promise<LittleFS>}
 */
export async function createLittleFS(options = {}) {
    console.info("[littlefs-wasm] createLittleFS() starting", options);
    
    const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    const blockCount = options.blockCount ?? DEFAULT_BLOCK_COUNT;
    const lookaheadSize = options.lookaheadSize ?? DEFAULT_LOOKAHEAD_SIZE;
    const diskVersion = options.diskVersion ?? DISK_VERSION_2_0;

    // Configure module with custom locateFile for WASM
    // Always set locateFile to ensure correct WASM path resolution
    const wasmURL = options.wasmURL ?? new URL('./littlefs.wasm', import.meta.url).href;
    const moduleConfig = createModuleConfig(wasmURL);

    // Initialize Emscripten module
    const Module = await createLittleFSModule(moduleConfig);
    console.info("[littlefs-wasm] Emscripten module loaded");
    try {
        // Set disk version before init to ensure new filesystems use the specified version
        // and to prevent automatic migration from older versions
        if (Module._lfs_wasm_set_disk_version) {
            Module._lfs_wasm_set_disk_version(diskVersion);
            console.info("[littlefs-wasm] Disk version set to:", formatDiskVersion(diskVersion));
        }

        // Initialize LittleFS
        const initResult = Module._lfs_wasm_init(blockSize, blockCount, lookaheadSize);
        if (initResult !== 0) {
            throw new LittleFSError(`Failed to initialize LittleFS: ${initResult}`, initResult);
        }

        // Format if requested
        if (options.formatOnInit) {
            const formatResult = Module._lfs_wasm_format();
            if (formatResult !== 0) {
                throw new LittleFSError(`Failed to format LittleFS: ${formatResult}`, formatResult);
            }
        }

        // Mount (with optional auto-format on failure)
        const mountResult = Module._lfs_wasm_mount();
        if (mountResult !== 0) {
            if (options.autoFormatOnMountFailure !== true) {
                throw new LittleFSError(`Failed to mount LittleFS: ${mountResult}`, mountResult);
            }
            console.warn("[littlefs-wasm] Mount failed, attempting format and remount...");
            const formatResult = Module._lfs_wasm_format();
            if (formatResult !== 0) {
                throw new LittleFSError(`Failed to format LittleFS: ${formatResult}`, formatResult);
            }
            const retryMount = Module._lfs_wasm_mount();
            if (retryMount !== 0) {
                throw new LittleFSError(`Failed to mount LittleFS: ${retryMount}`, retryMount);
            }
        }
    } catch (error) {
        // Clean up Module resources before rethrowing
        if (Module._lfs_wasm_cleanup) {
            try {
                Module._lfs_wasm_cleanup();
            } catch (cleanupError) {
                console.error("[littlefs-wasm] Cleanup during error handling failed:", cleanupError);
            }
        }
        throw error;
    }

    console.info("[littlefs-wasm] LittleFS mounted successfully");
    return createClient(Module, blockSize, blockCount);
}

/**
 * Create a LittleFS instance from an existing image
 * @param {Uint8Array|ArrayBuffer} image 
 * @param {LittleFSOptions} options 
 * @returns {Promise<LittleFS>}
 */
export async function createLittleFSFromImage(image, options = {}) {
    console.info("[littlefs-wasm] createLittleFSFromImage() starting");

    const imageData = image instanceof ArrayBuffer ? new Uint8Array(image) : image;
    const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    const blockCount = options.blockCount ?? Math.ceil(imageData.length / blockSize);
    const lookaheadSize = options.lookaheadSize ?? DEFAULT_LOOKAHEAD_SIZE;

    // Configure module with custom locateFile for WASM
    // Always set locateFile to ensure correct WASM path resolution
    const wasmURL = options.wasmURL ?? new URL('./littlefs.wasm', import.meta.url).href;
    const moduleConfig = createModuleConfig(wasmURL);

    // Initialize Emscripten module
    const Module = await createLittleFSModule(moduleConfig);
    console.info("[littlefs-wasm] Emscripten module loaded");

    // When loading from image, don't set disk version (preserve existing)
    // This is important to not trigger migration

    try {
        // Allocate memory for image
        const imagePtr = Module._malloc(imageData.length);
        if (!imagePtr) {
            throw new LittleFSError("Failed to allocate memory for image", -1);
        }

        try {
            // Copy image to WASM memory
            Module.HEAPU8.set(imageData, imagePtr);

            // Initialize from image
            const initResult = Module._lfs_wasm_init_from_image(
                imagePtr, 
                imageData.length, 
                blockSize, 
                blockCount, 
                lookaheadSize
            );
            
            if (initResult !== 0) {
                throw new LittleFSError(`Failed to initialize LittleFS from image: ${initResult}`, initResult);
            }
        } finally {
            Module._free(imagePtr);
        }

        // Mount
        const mountResult = Module._lfs_wasm_mount();
        if (mountResult !== 0) {
            throw new LittleFSError(`Failed to mount LittleFS: ${mountResult}`, mountResult);
        }
    } catch (error) {
        // Clean up Module resources before rethrowing
        if (Module._lfs_wasm_cleanup) {
            try {
                Module._lfs_wasm_cleanup();
            } catch (cleanupError) {
                console.error("[littlefs-wasm] Cleanup during error handling failed:", cleanupError);
            }
        }
        throw error;
    }

    // Get disk version after mounting
    const version = Module._lfs_wasm_get_disk_version ? Module._lfs_wasm_get_disk_version() : 0;
    console.info("[littlefs-wasm] LittleFS mounted from image, disk version:", formatDiskVersion(version));

    return createClient(Module, blockSize, blockCount);
}

/**
 * Create the client API wrapper
 */
function createClient(Module, blockSize, blockCount) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    function allocString(str) {
        const bytes = encoder.encode(str + '\0');
        const ptr = Module._malloc(bytes.length);
        if (!ptr) throw new LittleFSError("Failed to allocate string", -1);
        Module.HEAPU8.set(bytes, ptr);
        return ptr;
    }

    function readString(ptr, maxLength = 4096) {
        if (!ptr) return "";
        let end = ptr;
        const limit = ptr + maxLength;
        while (end < limit && Module.HEAPU8[end] !== 0) end++;
        if (end >= limit) {
            console.warn("[littlefs-wasm] String read truncated at maxLength");
        }
        return decoder.decode(Module.HEAPU8.subarray(ptr, end));
    }

    const client = {
        format() {
            const result = Module._lfs_wasm_format();
            if (result !== 0) {
                throw new LittleFSError(`Format failed: ${result}`, result);
            }
            // Remount after format
            const mountResult = Module._lfs_wasm_mount();
            if (mountResult !== 0) {
                throw new LittleFSError(`Mount after format failed: ${mountResult}`, mountResult);
            }
        },

        list(path = "/") {
            const entries = [];
            const pathPtr = allocString(path);
            let dirHandle = -1;
            
            try {
                // dir_open returns handle >= 0 on success, negative on error
                dirHandle = Module._lfs_wasm_dir_open(pathPtr);
                if (dirHandle < 0) {
                    throw new LittleFSError(`Failed to open directory: ${dirHandle}`, dirHandle);
                }

                const nameBuffer = Module._malloc(LFS_NAME_MAX + 1);
                const typePtr = Module._malloc(4);
                const sizePtr = Module._malloc(4);

                try {
                    while (true) {
                        // dir_read takes handle as first parameter
                        const readResult = Module._lfs_wasm_dir_read(dirHandle, nameBuffer, LFS_NAME_MAX, typePtr, sizePtr);
                        if (readResult === 0) break; // No more entries
                        if (readResult < 0) {
                            throw new LittleFSError(`Failed to read directory: ${readResult}`, readResult);
                        }

                        const name = readString(nameBuffer);
                        // . and .. are already filtered in C code, but double-check
                        if (name === "." || name === "..") continue;

                        const type = Module.HEAP32[typePtr >> 2];
                        const size = Module.HEAPU32[sizePtr >> 2];

                        const entryPath = path === "/" ? `/${name}` : `${path}/${name}`;
                        // type: 1 = file (LFS_TYPE_REG), 2 = directory (LFS_TYPE_DIR)
                        const isDir = type === 2;
                        entries.push({
                            path: entryPath,
                            name,
                            size: isDir ? 0 : size,  // Files have size, directories don't
                            type: isDir ? "dir" : "file"
                        });
                    }
                } finally {
                    Module._free(nameBuffer);
                    Module._free(typePtr);
                    Module._free(sizePtr);
                }

                // dir_close takes handle as parameter
                Module._lfs_wasm_dir_close(dirHandle);
                dirHandle = -1; // Mark as closed
            } finally {
                Module._free(pathPtr);
                // Close handle if still open (in case of exception)
                if (dirHandle >= 0) {
                    Module._lfs_wasm_dir_close(dirHandle);
                }
            }

            return entries;
        },

        readFile(path) {
            const pathPtr = allocString(path);
            try {
                // Get file size first
                const size = Module._lfs_wasm_file_size(pathPtr);
                if (size < 0) {
                    throw new LittleFSError(`Failed to get file size: ${size}`, size);
                }

                const dataPtr = Module._malloc(size);
                if (!dataPtr && size > 0) {
                    throw new LittleFSError("Failed to allocate read buffer", -1);
                }

                try {
                    const readResult = Module._lfs_wasm_read_file(pathPtr, dataPtr, size);
                    if (readResult < 0) {
                        throw new LittleFSError(`Failed to read file: ${readResult}`, readResult);
                    }
                    return new Uint8Array(Module.HEAPU8.buffer, dataPtr, readResult).slice();
                } finally {
                    Module._free(dataPtr);
                }
            } finally {
                Module._free(pathPtr);
            }
        },

        writeFile(path, data) {
            const pathPtr = allocString(path);
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            const dataPtr = Module._malloc(bytes.length);
            
            if (!dataPtr && bytes.length > 0) {
                Module._free(pathPtr);
                throw new LittleFSError("Failed to allocate write buffer", -1);
            }

            try {
                Module.HEAPU8.set(bytes, dataPtr);
                const result = Module._lfs_wasm_write_file(pathPtr, dataPtr, bytes.length);
                if (result < 0) {
                    if (result === LFS_ERR_NOSPC) {
                        throw new LittleFSError("No space left on device", result);
                    }
                    throw new LittleFSError(`Failed to write file: ${result}`, result);
                }
            } finally {
                Module._free(pathPtr);
                Module._free(dataPtr);
            }
        },

        addFile(path, data) {
            return this.writeFile(path, data);
        },

        deleteFile(path) {
            const pathPtr = allocString(path);
            try {
                const result = Module._lfs_wasm_remove(pathPtr);
                if (result !== 0) {
                    throw new LittleFSError(`Failed to delete: ${result}`, result);
                }
            } finally {
                Module._free(pathPtr);
            }
        },

        delete(path, options = {}) {
            if (options.recursive) {
                // List contents and delete recursively
                try {
                    const entries = this.list(path);
                    for (const entry of entries) {
                        if (entry.type === "dir") {
                            this.delete(entry.path, { recursive: true });
                        } else {
                            this.deleteFile(entry.path);
                        }
                    }
                } catch (e) {
                    // Directory might be empty or not exist, log other errors
                    if (e.code !== -2) { // -2 is ENOENT
                        console.warn("[littlefs-wasm] Error during recursive delete:", e);
                    }
                }
            }
            this.deleteFile(path);
        },

        mkdir(path) {
            const pathPtr = allocString(path);
            try {
                const result = Module._lfs_wasm_mkdir(pathPtr);
                // Ignore "already exists" error
                if (result !== 0 && result !== -17) {
                    throw new LittleFSError(`Failed to create directory: ${result}`, result);
                }
            } finally {
                Module._free(pathPtr);
            }
        },

        rename(oldPath, newPath) {
            const oldPtr = allocString(oldPath);
            const newPtr = allocString(newPath);
            try {
                const result = Module._lfs_wasm_rename(oldPtr, newPtr);
                if (result !== 0) {
                    throw new LittleFSError(`Failed to rename: ${result}`, result);
                }
            } finally {
                Module._free(oldPtr);
                Module._free(newPtr);
            }
        },

        toImage() {
            const size = Module._lfs_wasm_get_image_size();
            if (size <= 0) {
                throw new LittleFSError(`Invalid image size: ${size}`, size);
            }

            const ptr = Module._lfs_wasm_get_image();
            if (!ptr) {
                throw new LittleFSError("Failed to get image pointer", -1);
            }

            // Note: ptr points to internal ram_storage buffer, not allocated memory
            // slice() already copies the data, so we must NOT free this pointer
            return new Uint8Array(Module.HEAPU8.buffer, ptr, size).slice();
        },

        getDiskVersion() {
            if (Module._lfs_wasm_get_fs_info) {
                const versionPtr = Module._malloc(4);
                try {
                    const result = Module._lfs_wasm_get_fs_info(versionPtr);
                    if (result === 0) {
                        return Module.HEAPU32[versionPtr >> 2];
                    }
                } finally {
                    Module._free(versionPtr);
                }
            }
            console.warn("[littlefs-wasm] getDiskVersion not available or filesystem not mounted");
            return 0;
        },

        setDiskVersion(version) {
            if (Module._lfs_wasm_set_disk_version) {
                Module._lfs_wasm_set_disk_version(version);
            } else {
                console.warn("[littlefs-wasm] setDiskVersion not available");
            }
        },

        getUsage() {
            const blockUsedPtr = Module._malloc(4);
            const blockTotalPtr = Module._malloc(4);
            
            try {
                const result = Module._lfs_wasm_fs_stat(blockUsedPtr, blockTotalPtr);
                if (result !== 0) {
                    // Fallback estimation
                    return {
                        capacityBytes: blockSize * blockCount,
                        usedBytes: 0,
                        freeBytes: blockSize * blockCount
                    };
                }

                const blocksUsed = Module.HEAPU32[blockUsedPtr >> 2];
                const blocksTotal = Module.HEAPU32[blockTotalPtr >> 2];

                const capacityBytes = blocksTotal * blockSize;
                const usedBytes = blocksUsed * blockSize;

                return {
                    capacityBytes,
                    usedBytes,
                    freeBytes: Math.max(0, capacityBytes - usedBytes)
                };
            } finally {
                Module._free(blockUsedPtr);
                Module._free(blockTotalPtr);
            }
        },

        canFit(path, size) {
            const usage = this.getUsage();
            return usage.freeBytes >= size;
        },

        cleanup() {
            Module._lfs_wasm_unmount();
            Module._lfs_wasm_cleanup();
        }
    };

    return client;
}

// Default export for CommonJS compatibility
export default { createLittleFS, createLittleFSFromImage, DISK_VERSION_2_0, DISK_VERSION_2_1, LFS_NAME_MAX, formatDiskVersion };
