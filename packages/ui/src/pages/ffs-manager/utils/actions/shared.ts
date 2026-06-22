/**
 * 把 Uint8Array 转成适合 RPC 传输的 number[]。
 * @param bytes - 原始字节数组
 */
export const toFfsByteArray = (bytes: Uint8Array) => Array.from(bytes)
