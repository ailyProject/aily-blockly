// 这个文件要作废，不要使用这个文件  陈吕洲 2025.2.27

// 处理json文件中的generator部分
export function processingJsonGenerator(blockJson) {
    if (blockJson.generator) {
        let Arduino: any = window['Arduino']
        let getValue: any = window['getValue']
        Arduino.forBlock[blockJson.type] = (block) => {
            // 添加宏
            if (blockJson.generator.macro) {
                window['addMacro'](blockJson.generator.macro, blockJson.generator.macro)
            }
            // 添加库
            if (blockJson.generator.library) {
                window['addLibrary'](blockJson.generator.library, blockJson.generator.library)
            }
            // 变量表，用于最后替换变量
            let VarsDict = {}

            if (blockJson.args0) {
                blockJson.args0.forEach(arg => {
                    if (arg.name)
                        VarsDict['${' + arg.name + '}'] = getValue(block, arg.name, arg.type)
                });
            }

            if (blockJson.args1) {
                blockJson.args1.forEach(arg => {
                    if (arg.name)
                        VarsDict['${' + arg.name + '}'] = getValue(block, arg.name, arg.type)
                });
            }
            if (blockJson.args2) {
                blockJson.args2.forEach(arg => {
                    if (arg.name)
                        VarsDict['${' + arg.name + '}'] = getValue(block, arg.name, arg.type)
                });
            }
            if (blockJson.args3) {
                blockJson.args3.forEach(arg => {
                    if (arg.name)
                        VarsDict['${' + arg.name + '}'] = getValue(block, arg.name, arg.type)
                });
            }

            if (blockJson.generator.object) {
                let primary
                if (blockJson.generator.primary) primary = processJsonCodeVar(blockJson.generator.primary, VarsDict);
                let className: string = blockJson.generator.object.split(' ')[0]
                VarsDict['${OBJECT_NAME}'] = className.toLowerCase() + '_' + primary;
                let object_code = processJsonCodeVar(blockJson.generator.object, VarsDict)
                window['addObject'](VarsDict['${OBJECT_NAME}'], object_code)
            }
            if (blockJson.generator.function) {
                let functionBody = processJsonCodeVar(blockJson.generator.function, VarsDict)
                window['addFunction'](blockJson.generator.function, functionBody)
            }
            if (blockJson.generator.setup) {
                let setup_code = processJsonCodeVar(blockJson.generator.setup, VarsDict)
                window['addSetup'](VarsDict['${OBJECT_NAME}'], setup_code)
            }
            if (blockJson.generator.code) {
                let code = processJsonCodeVar(blockJson.generator.code, VarsDict)
                return blockJson.output ? code : code + '\n'
            } else return '';

        }
    }

    // // 判断库是否被用户隐藏
    // if (this.libDict_show[libName])
    //     if (!this.libDict_show[libName].show) {
    //         return
    //     }
    // 如果是按键，直接添加到toolbox
    // if (blockJson.kind == 'button') {
    //     let buttonJson = blockJson
    //     this.addButtonToCategory(libJson, buttonJson)
    //     return
    // }
    // // 添加到toolbox
    // if (blockJson.toolbox) {
    //     if (!blockJson.toolbox.show) return
    //     this.addBlockToCategory(libJson, blockJson)
    // }

}

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
            // console.log(itemName);
            let data = JSON.parse(JSON.stringify(boardConfig))
            // console.log(data);
            // itemName.split('.').forEach(el => {
            //     console.log(el);

            //     data = data[el]
            // })
            data = data[getLastElement(itemName.split('.'))]
            jsonString = jsonString.replace(item, JSON.stringify(data))
        });
    }
    return JSON.parse(jsonString)
}

/**
 *  处理json文件中的代码生成中的变量，如：${PIN1}
 */
export function processJsonCodeVar(code: string, vars: object): string {
    // console.log(code, vars)
    for (const varName in vars) {
        let reg = new RegExp('\\' + varName, 'g')
        code = code.replace(reg, vars[varName])
    }
    try {
        code = code.replace(/{{([\s\S]*?)}}/g, function () {
            let str = arguments[1].replace(/\${([\s\S]*?)}(?=|[\s;])/g, function () {
                if (arguments[1] === '') return JSON.stringify(arguments[1]);
                return JSON.stringify(arguments[0]);
            });
            if (str.indexOf('return ') === -1) str = 'return ' + str;
            str = (new Function(str))();
            str = str.replace(/"\${([\s\S]*?)}"(?=|[\s;])/g, function () {
                return arguments[1];
            })
            return str;
        })
    } catch (e) {

    }
    return code
}

function getLastElement<T>(array: T[]): T | undefined {
    if (array.length === 0) {
        return undefined;
    }
    return array[array.length - 1];
}