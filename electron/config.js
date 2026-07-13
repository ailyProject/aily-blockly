// 提供应用配置文件的读取和创建功能。
// 加载配置文件
export function loadConfigFile() {
    const path = path.join(__dirname, "config.json");
}

// 创建配置文件
export function creatConfigFile() {
    console.log(process.env.LANG);
}