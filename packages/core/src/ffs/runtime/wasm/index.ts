import { readFile } from 'node:fs/promises'

/**
 * FatFS Wasm 模块地址。
 */
export const fatfsWasmUrl = new URL('./fatfs/fatfs.wasm', import.meta.url)

/**
 * LittleFS Wasm 模块地址。
 */
export const littlefsWasmUrl = new URL('./littlefs/littlefs.wasm', import.meta.url)

/**
 * SPIFFS Wasm 模块地址。
 */
export const spiffsWasmUrl = new URL('./spiffs/spiffs.wasm', import.meta.url)

/**
 * 读取 Wasm 二进制。
 * @param url - Wasm 文件地址
 */
export const readFfsWasmBinary = (url: URL) => readFile(url)
