
export async function getDefaultBuildPath(sketchFilePath: string): Promise<string> {
    console.log("sketchFilePath: ", sketchFilePath);
    const sketchMd5Value = await window["tools"].calculateMD5(window['path'].resolve(sketchFilePath));
    const sketchMd5 = sketchMd5Value.slice(0, 8);
    const sketchName = window['path'].basename(sketchFilePath, '.ino');
    return `${window['path'].getAilyBuilderBuildPath()}\\${sketchName}_${sketchMd5}`;
}

/**
   * 文件查找
   */
export async function findFile(basePath: string, fileName: string, version: string = ''): Promise<string> {
    // 先判断basePath是否存在
    if (!window['fs'].existsSync(basePath)) {
        console.warn(`路径不存在: ${basePath}`);
        return '';
    }

    // 保持原始fileName，不进行*替换，让底层工具处理通配符
    const findRes = await window['tools'].findFileByName(basePath, fileName);
    console.log(`find ${fileName} in tools: `, findRes);

    let filteredRes = findRes;

    // 如果传入的是 *.bin 这样的模式，过滤结果只返回确切匹配的文件
    if (fileName.includes('*')) {
        // 将通配符模式转换为正则表达式
        const pattern = fileName.replace(/\*/g, '([^.]+)').replace(/\./g, '\\.');
        const regex = new RegExp(`^${pattern}$`);

        filteredRes = findRes.filter((filePath: string) => {
            const baseName = window['path'].basename(filePath);
            return regex.test(baseName);
        });
    }

    // 如果有version参数且结果包含多个文件，优先返回路径中包含version的文件
    if (version && filteredRes.length > 1) {
        const versionMatched = filteredRes.filter((filePath: string) => {
            return filePath.includes(version);
        });
        
        if (versionMatched.length > 0) {
            return versionMatched[0];
        }
    }

    return filteredRes[0] || '';
}