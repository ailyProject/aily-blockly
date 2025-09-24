
// import { MD5 } from 'crypto-js';

/*
根据日期生成字符串，如 5月1日，生成为“may01”
*/
export function generateDateString(date: Date = new Date()): string {
    const monthAbbr = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    // 获取月份（getMonth 返回值为 0-11）
    const month = monthAbbr[date.getMonth()];
    // 获取日期并格式化为两位数字
    const day = date.getDate().toString().padStart(2, '0');
    // 返回形如 "may01" 的字符串
    return `${month}${day}`;
}

// /**
//  * 计算文本的MD5值
//  * @param text 要计算MD5的文本
//  * @returns MD5哈希值（32位十六进制字符串）
//  */
// export function calculateMD5(text: string): string {
//     return MD5(text).toString();
// }