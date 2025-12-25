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