
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
            // 处理 tooltip 字段
            if (i18nData[blockType].tooltip !== undefined) {
                block.tooltip = i18nData[blockType].tooltip;
            }

            // 处理 helpUrl 字段
            if (i18nData[blockType].helpUrl !== undefined) {
                block.helpUrl = i18nData[blockType].helpUrl;
            }

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

/**
 * 处理 toolbox 的多语言
 * @param {object} toolbox - toolbox JSON对象
 * @param {object} i18nData - 多语言数据
 * @returns {object} - 处理后的toolbox对象
 */
export function processToolboxI18n(toolbox, i18nData) {
    if (!i18nData) return toolbox;
    
    // 创建toolbox的副本，避免修改原始数据
    const updatedToolbox = JSON.parse(JSON.stringify(toolbox));
    
    // 处理 toolbox name
    if (i18nData.toolbox_name) {
        updatedToolbox.name = i18nData.toolbox_name;
    }
    
    // 处理 toolbox contents 中的 labels 和 category names
    if (updatedToolbox.contents && (i18nData.toolbox_labels || i18nData.toolbox_categories)) {
        processToolboxContents(updatedToolbox.contents, i18nData.toolbox_labels || {}, i18nData.toolbox_categories);
    }
    
    return updatedToolbox;
}

/**
 * 递归处理 toolbox contents 中的 label text 和 category name
 * @param {array} contents - toolbox contents 数组
 * @param {object} labels - label text 多语言映射 { "原文": "翻译" }
 * @param {array} categories - 按深度优先顺序排列的 category name 翻译
 */
function processToolboxContents(contents, labels = {}, categories, state = { categoryIndex: 0 }) {
    if (!Array.isArray(contents)) return;
    
    for (const item of contents) {
        // 处理 label 类型
        if (item.kind === 'label' && item.text && labels[item.text]) {
            item.text = labels[item.text];
        }

        if (item.kind === 'category') {
            const categoryTranslation = Array.isArray(categories) ? categories[state.categoryIndex] : undefined;

            state.categoryIndex++;

            if (typeof categoryTranslation === 'string' && categoryTranslation) {
                item.name = categoryTranslation;
            }
        }
        
        // 递归处理嵌套的 contents（如 category 中的内容）
        if (item.contents) {
            processToolboxContents(item.contents, labels, categories, state);
        }
    }
}

function getLastElement<T>(array: T[]): T | undefined {
    if (array.length === 0) {
        return undefined;
    }
    return array[array.length - 1];
}

type BoardSerialPortOption = [string, string];

function cloneBoardSerialPortOptions(options: BoardSerialPortOption[]): BoardSerialPortOption[] {
    return options.map(([label, value]) => [label, value]);
}

export const CDC_REPLACED_SERIAL_LABEL = 'Serial0';
export const CDC_REPLACED_SERIAL_VALUE = 'Serial0';

/**
 * CDC 禁用时，将工作区中 SERIAL 字段值映射回原始 serialPort 项。
 * - 选中 CDC 项（value 为 cdcSerialPort[i][1]，如 Serial2）→ 保持该 value
 * - 选中被替换后的 Serial0（原硬件 Serial2）→ 映射回 cdcSerialPort[i][1]
 */
export function resolveSerialPortValueAfterCdcDisabled(
    currentValue: string,
    cdcSerialPort: BoardSerialPortOption[],
): string {
    if (!currentValue || !Array.isArray(cdcSerialPort) || cdcSerialPort.length === 0) {
        return currentValue;
    }

    if (currentValue === CDC_REPLACED_SERIAL_VALUE) {
        for (const entry of cdcSerialPort) {
            if (Array.isArray(entry) && entry.length >= 2) {
                return String(entry[1]);
            }
        }
    }

    for (const entry of cdcSerialPort) {
        if (Array.isArray(entry) && entry.length >= 2 && String(entry[1]) === currentValue) {
            return currentValue;
        }
    }

    return currentValue;
}

/**
 * 根据 USB CDC 开关调整 serialPort / serialPins：
 * - cdcSerialPort[i][1] 与 serialPort[j][1] 相同者视为被替换项，改为 ["Serial0", "Serial0"]
 * - serialPins 中对应 key 从被替换 value 重命名为 "Serial0"
 * - 在 serialPort 首部插入 cdcSerialPort 项（如 ["Serial(USB CDC)", "Serial"]）
 */
export function applyCdcSerialPortOverrides(
    boardConfig: any,
    cdcEnabled: boolean,
): any {
    if (!boardConfig || !Array.isArray(boardConfig.cdcSerialPort) || boardConfig.cdcSerialPort.length === 0) {
        if (boardConfig) {
            boardConfig._cdcEnabled = false;
        }
        return boardConfig;
    }

    const baseSerialPort: BoardSerialPortOption[] = Array.isArray(boardConfig._serialPortBase)
        ? cloneBoardSerialPortOptions(boardConfig._serialPortBase)
        : cloneBoardSerialPortOptions(boardConfig.serialPort || []);

    boardConfig._serialPortBase = cloneBoardSerialPortOptions(baseSerialPort);

    if (boardConfig.serialPins && !boardConfig._serialPinsBase) {
        boardConfig._serialPinsBase = JSON.parse(JSON.stringify(boardConfig.serialPins));
    }

    if (!cdcEnabled) {
        boardConfig.serialPort = cloneBoardSerialPortOptions(baseSerialPort);
        delete boardConfig.serialPortOriginal;
        if (boardConfig._serialPinsBase) {
            boardConfig.serialPins = JSON.parse(JSON.stringify(boardConfig._serialPinsBase));
        }
        boardConfig._cdcEnabled = false;
        return boardConfig;
    }

    const cdcValues = new Set<string>();
    const cdcEntries: BoardSerialPortOption[] = [];
    for (const entry of boardConfig.cdcSerialPort) {
        if (!Array.isArray(entry) || entry.length < 2) {
            continue;
        }
        cdcValues.add(String(entry[1]));
        cdcEntries.push([String(entry[0]), String(entry[1])]);
    }

    boardConfig.serialPort = baseSerialPort.map(([label, value]) => {
        if (cdcValues.has(value)) {
            return [CDC_REPLACED_SERIAL_LABEL, CDC_REPLACED_SERIAL_VALUE];
        }
        return [label, value];
    });
    boardConfig.serialPort = [...cdcEntries, ...boardConfig.serialPort];
    delete boardConfig.serialPortOriginal;

    if (boardConfig.serialPins && typeof boardConfig.serialPins === 'object') {
        boardConfig.serialPins = boardConfig._serialPinsBase
            ? JSON.parse(JSON.stringify(boardConfig._serialPinsBase))
            : JSON.parse(JSON.stringify(boardConfig.serialPins));

        for (const cdcValue of cdcValues) {
            const pins = boardConfig.serialPins[cdcValue];
            if (pins === undefined) {
                continue;
            }
            boardConfig.serialPins[CDC_REPLACED_SERIAL_VALUE] = JSON.parse(JSON.stringify(pins));
            delete boardConfig.serialPins[cdcValue];
        }
    }

    boardConfig._cdcEnabled = true;
    return boardConfig;
}
