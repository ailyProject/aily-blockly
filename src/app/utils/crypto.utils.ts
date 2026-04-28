/**
 * 使用原生 Web Crypto API 计算 SHA-256 哈希，返回十六进制字符串。
 * 兼容浏览器及 Electron 渲染进程（均支持 window.crypto.subtle）。
 */
export async function sha256Hex(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
