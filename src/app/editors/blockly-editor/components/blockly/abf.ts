
/**
 * 替换json配置中的board相关变量
 * @param {object} sourceJson - 需要处理的JSON对象
 * @returns {object} - 处理后的JSON对象
 */
export function processJsonVar(sourceJson, boardConfig) {
    let jsonString = JSON.stringify(sourceJson)
    let result = jsonString.match(/"\$\{board\.(\S*?)\}"/g)
    if (result != null) {
        // console.log(result);
        result.forEach(item => {
            let itemName = item.replace('"${', '').replace('}"', '')
            let data = JSON.parse(JSON.stringify(boardConfig))
            data = data[getLastElement(itemName.split('.'))]
            jsonString = jsonString.replace(item, JSON.stringify(data))
        });
    }
    return JSON.parse(jsonString)
}

/**
 * 替换json配置中的静态文件路径
 * @param {object} sourceJson - 需要处理的JSON对象
 * @param {string} libStaticPath - 静态文件基础路径
 * @returns {object} - 处理后的JSON对象
 */
export function processStaticFilePath(sourceJson, libStaticPath) {
    // 检查是否包含 field_image
    const jsonString = JSON.stringify(sourceJson);
    if (jsonString.indexOf('"field_image"') === -1) {
        return sourceJson;
    }
    
    const processedJson = JSON.parse(JSON.stringify(sourceJson));
    // 递归处理对象
    function processObject(obj) {
        if (Array.isArray(obj)) {
            // 如果是数组，遍历每个元素
            obj.forEach(item => processObject(item));
        } else if (obj && typeof obj === 'object') {
            // 如果是对象，检查是否是 field_image 类型
            if (obj.type === 'field_image' && obj.src) {
                // 判断 src 是否只是文件名（没有完整路径、没有协议）
                const src = obj.src;

                // 检查是否已经包含协议或完整路径
                const hasProtocol = /^(https?|file|data):/i.test(src);
                const hasPath = src.includes('/') || src.includes('\\');

                // 如果只是文件名，添加 libStaticPath
                if (!hasProtocol && !hasPath) {
                    obj.src = libStaticPath + (libStaticPath.endsWith('/') ? '' : '/') + src;
                }
            }

            // 递归处理对象的所有属性
            Object.values(obj).forEach(value => processObject(value));
        }
    }

    processObject(processedJson);
    return processedJson;
}

export function processI18n(sourceJson, i18nData) {
    // 创建blocks的副本，避免修改原始数据
    const updatedBlocks = JSON.parse(JSON.stringify(sourceJson));

    // 遍历blocks数组
    for (let i = 0; i < updatedBlocks.length; i++) {
        const block = updatedBlocks[i];
        const blockType = block.type;

        // 检查i18n中是否有对应类型的块
        if (i18nData[blockType]) {
            // 检查所有可能的message字段
            let messageIndex = 0;
            // 循环检查原始块中的每个messageX字段
            while (block[`message${messageIndex}`] !== undefined) {
                const messageKey = `message${messageIndex}`;

                // 如果i18n数据中存在对应的翻译，则替换
                if (i18nData[blockType][messageKey]) {
                    block[messageKey] = i18nData[blockType][messageKey];
                }

                // 处理args0字段
                const argsKey = `args${messageIndex}`;
                if (block[argsKey] && i18nData[blockType][argsKey]) {
                    // 遍历args数组中的每个元素
                    for (let j = 0; j < block[argsKey].length; j++) {
                        // 确保i18nData中有对应索引的元素且不为null
                        if (i18nData[blockType][argsKey][j] !== undefined &&
                            i18nData[blockType][argsKey][j] !== null) {

                            // 如果是对象，则合并属性
                            if (typeof block[argsKey][j] === 'object' &&
                                block[argsKey][j] !== null &&
                                typeof i18nData[blockType][argsKey][j] === 'object') {

                                // 处理特殊情况：options数组
                                if (block[argsKey][j].options && i18nData[blockType][argsKey][j].options) {
                                    block[argsKey][j].options = i18nData[blockType][argsKey][j].options;
                                } else {
                                    // 合并其他属性
                                    Object.assign(block[argsKey][j], i18nData[blockType][argsKey][j]);
                                }
                            } else {
                                // 直接替换整个元素
                                block[argsKey][j] = i18nData[blockType][argsKey][j];
                            }
                        }
                    }
                }

                // 检查下一个messageX字段
                messageIndex++;
            }
        }
    }
    return updatedBlocks;
}

function getLastElement<T>(array: T[]): T | undefined {
    if (array.length === 0) {
        return undefined;
    }
    return array[array.length - 1];
}