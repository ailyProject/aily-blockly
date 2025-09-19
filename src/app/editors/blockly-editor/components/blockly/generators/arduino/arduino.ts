import * as Blockly from 'blockly';

export enum Order {
  ATOMIC = 0, // 0 "" ...
  NEW = 1.1, // new
  MEMBER = 1.2, // . []
  FUNCTION_CALL = 2, // ()
  INCREMENT = 3, // ++
  DECREMENT = 3, // --
  BITWISE_NOT = 4.1, // ~
  UNARY_PLUS = 4.2, // +
  UNARY_NEGATION = 4.3, // -
  LOGICAL_NOT = 4.4, // !
  TYPEOF = 4.5, // typeof
  VOID = 4.6, // void
  DELETE = 4.7, // delete
  AWAIT = 4.8, // await
  EXPONENTIATION = 5.0, // **
  MULTIPLICATION = 5.1, // *
  DIVISION = 5.2, // /
  MODULUS = 5.3, // %
  SUBTRACTION = 6.1, // -
  ADDITION = 6.2, // +
  BITWISE_SHIFT = 7, // << >> >>>
  RELATIONAL = 8, // < <= > >=
  IN = 8, // in
  INSTANCEOF = 8, // instanceof
  EQUALITY = 9, // == != === !==
  BITWISE_AND = 10, // &
  BITWISE_XOR = 11, // ^
  BITWISE_OR = 12, // |
  LOGICAL_AND = 13, // &&
  LOGICAL_OR = 14, // ||
  CONDITIONAL = 15, // ?:
  ASSIGNMENT = 16, // = += -= **= *= /= %= <<= >>= ...
  YIELD = 17, // yield
  COMMA = 18, // ,
  NONE = 99, // (...)
}

const stringUtils = Blockly.utils.string;
const inputTypes = Blockly.inputs.inputTypes;

export class ArduinoGenerator extends Blockly.CodeGenerator {
  codeDict = {};
  
  // 用于存储代码副本，格式为 [{text: string, id: string}, ...]
  codeCopy: Array<{text: string, id: string}> = [];
  
  // 用于跟踪block到代码的映射
  blockToCodeMap: Map<string, string[]> = new Map();

  /** @param name Name of the language the generator is for. */
  constructor(name = 'Arduino') {
    super(name);
    this.isInitialized = false;

    for (const key in Order) {
      const value = Order[key];
      if (typeof value === 'string') continue;
      (this as unknown as Record<string, Order>)['ORDER_' + key] = value;
    }

    this.addReservedWords(
      'setup,loop,if,else,for,switch,case,while,do,break,continue,return,goto,' +
      'define,include,HIGH,LOW,INPUT,OUTPUT,INPUT_PULLUP,true,false,integer,' +
      'constants,floating,point,void,boolean,char,unsigned,byte,int,word,long,' +
      'float,double,string,String,array,static,volatile,const,sizeof,pinMode,' +
      'digitalWrite,digitalRead,analogReference,analogRead,analogWrite,tone,' +
      'noTone,shiftOut,shitIn,pulseIn,millis,micros,delay,delayMicroseconds,' +
      'min,max,abs,constrain,map,pow,sqrt,sin,cos,tan,randomSeed,random,' +
      'lowByte,highByte,bitRead,bitWrite,bitSet,bitClear,bit,attachInterrupt,' +
      'detachInterrupt,interrupts,noInterrupts',
    );
  }

  /**
   * 重写workspaceToCode方法以创建代码副本
   * @param workspace The workspace to generate code from
   * @returns The generated code
   */
  override workspaceToCode(workspace: Blockly.Workspace): string {
    // 在生成新代码之前清空相关数据
    this.codeCopy = [];
    this.blockToCodeMap.clear();

    // 调用父类的workspaceToCode方法生成最终代码
    const code = super.workspaceToCode(workspace);

    return code;
  }

  /**
   * 重写blockToCode方法以收集block代码映射
   * @param block The block to generate code for
   * @returns The generated code
   */
  override blockToCode(block: Blockly.Block | null): string | [string, number] {
    if (!block) {
      return '';
    }

    // 调用父类的blockToCode方法生成代码
    const codeResult = super.blockToCode(block);

    // 处理代码结果（可能是string或者[string, number]）
    let codeText: string;
    if (Array.isArray(codeResult)) {
      codeText = codeResult[0];
    } else {
      codeText = codeResult;
    }

    // 如果有代码生成，记录映射关系
    if (codeText && codeText.trim()) {
      if (!this.blockToCodeMap.has(block.id)) {
        this.blockToCodeMap.set(block.id, []);
      }
      // 将代码按行分割，每行都与当前block关联
      const lines = codeText.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          this.blockToCodeMap.get(block.id)!.push(line.trim());
        }
      }
    }

    return codeResult;
  }

  /**
   * Initialise the database of variable names.
   *
   * @param workspace Workspace to generate code from.
   */
  override init(workspace: Blockly.Workspace) {
    super.init(workspace);

    if (!this.nameDB_) {
      this.nameDB_ = new Blockly.Names(this.RESERVED_WORDS_);
    } else {
      this.nameDB_.reset();
    }

    this.nameDB_.setVariableMap(workspace.getVariableMap());
    this.nameDB_.populateVariables(workspace);
    this.nameDB_.populateProcedures(workspace);

    const defvars = [];
    // Add developer variables (not created or named by the user).
    const devVarList = Blockly.Variables.allDeveloperVariables(workspace);
    for (let i = 0; i < devVarList.length; i++) {
      defvars.push(
        this.nameDB_.getName(
          devVarList[i],
          Blockly.Names.NameType.DEVELOPER_VARIABLE,
        ),
      );
    }

    // Add user variables, but only ones that are being used.
    const variables = Blockly.Variables.allUsedVarModels(workspace);
    for (let i = 0; i < variables.length; i++) {
      defvars.push(
        this.nameDB_.getName(
          variables[i].getId(),
          Blockly.Names.NameType.VARIABLE,
        ),
      );
    }

    // Declare all of the variables.
    if (defvars.length) {
      this.definitions_['variables'] = 'var ' + defvars.join(', ') + ';';
    }

    // codeDict主要是为了防止代码重复生成
    this.codeDict = {};
    // 宏定义
    this.codeDict['macros'] = Object.create(null);
    // 库引用
    this.codeDict['libraries'] = Object.create(null);
    // 变量
    this.codeDict['variables'] = Object.create(null);
    // 对象
    this.codeDict['objects'] = Object.create(null);
    // 函数
    this.codeDict['functions'] = Object.create(null);
    // setup
    this.codeDict['setups'] = Object.create(null);
    // 用户自定义setup
    this.codeDict['setups_begin'] = Object.create(null);
    // 用户自定义setup1
    this.codeDict['setups_end'] = Object.create(null);
    // loop
    this.codeDict['loops'] = Object.create(null);
    // 用户自定义loop
    this.codeDict['loops_begin'] = Object.create(null);
    // 用户自定义loop1
    this.codeDict['loops_end'] = Object.create(null);

    this.isInitialized = true;
  }

  /**
   * Prepend the generated code with the variable definitions.
   *
   * @param code Generated code.
   * @returns Completed code.
   */
  override finish(code: string): string {
    super.finish(code);
    // this.isInitialized = false;
    this.nameDB_!.reset();

    // 提取代码
    let macros = [];
    let libraries = [];
    let variables = [];
    let objects = [];
    let functions = [];
    let setups = [];
    let setups_begin = [];
    let setups_end = [];
    let loops = [];
    let loops_begin = [];
    let loops_end = [];

    for (const key in this.codeDict['macros']) {
      macros.push(this.codeDict['macros'][key]);
    }
    for (const key in this.codeDict['libraries']) {
      libraries.push(this.codeDict['libraries'][key]);
    }
    for (const key in this.codeDict['variables']) {
      variables.push(this.codeDict['variables'][key]);
    }
    for (const key in this.codeDict['objects']) {
      objects.push(this.codeDict['objects'][key]);
    }
    for (const key in this.codeDict['functions']) {
      functions.push(this.codeDict['functions'][key]);
    }
    for (const key in this.codeDict['setups_begin']) {
      setups_begin.push(this.codeDict['setups_begin'][key]);
    }
    for (const key in this.codeDict['setups_end']) {
      setups_end.push(this.codeDict['setups_end'][key]);
    }
    for (const key in this.codeDict['setups']) {
      setups.push(this.codeDict['setups'][key]);
    }
    for (const key in this.codeDict['loops_begin']) {
      loops_begin.push(this.codeDict['loops_begin'][key]);
    }
    for (const key in this.codeDict['loops_end']) {
      loops_end.push(this.codeDict['loops_end'][key]);
    }
    for (const key in this.codeDict['loops']) {
      loops.push(this.codeDict['loops'][key]);
    }

    this.isInitialized = false;

    let newcode =
      `#include <Arduino.h>\n\n` +
      (macros.length > 0 ? `${macros.join('\n')}\n\n` : '') +
      (libraries.length > 0 ? `${libraries.join('\n')}\n\n` : '') +
      (variables.length > 0 ? `${variables.join('\n')}\n\n` : '') +
      (objects.length > 0 ? `${objects.join('\n')}\n\n` : '') +
      (functions.length > 0 ? `${functions.join('\n')}\n\n` : '') +
      `void setup() {\n` +
      (setups_begin.length > 0 ? `  ${setups_begin.join('\n  ')}\n` : '') + '\n' +
      (setups.length > 0 ? `${setups.join('\n  ')}\n` : '') +
      (setups_end.length > 0 ? `    ${setups_end.join('\n  ')}\n` : '') +
      `}\n\n` +
      `void loop() {\n` +
      (loops_begin.length > 0 ? `  ${loops_begin.join('\n  ')}\n` : '') + '\n' +
      (loops.length > 0 ? `${loops.join('\n  ')}\n` : '') +
      (loops_end.length > 0 ? `  ${loops_end.join('\n  ')}\n` : '') +
      `}`;

    // 创建代码副本，将每行代码与对应的block id关联
    this.createCodeCopy(newcode);

    return newcode;
  }

  /**
   * Naked values are top-level blocks with outputs that aren't plugged into
   * anything.  A trailing semicolon is needed to make this legal.
   *
   * @param line Line of generated code.
   * @returns Legal line of code.
   */
  override scrubNakedValue(line: string): string {
    return line + ';\n';
  }

  /**
   * Encode a string as a properly escaped JavaScript string, complete with
   * quotes.
   *
   * @param string Text to encode.
   * @returns JavaScript string.
   */
  quote_(string: string): string {
    // Can't use goog.string.quote since Google's style guide recommends
    // JS string literals use single quotes.
    string = string
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\\n')
      .replace(/'/g, "\\'");
    return "\"" + string + "\"";
  }

  /**
   * Encode a string as a properly escaped multiline JavaScript string, complete
   * with quotes.
   * @param string Text to encode.
   * @returns JavaScript string.
   */
  multiline_quote_(string: string): string {
    // Can't use goog.string.quote since Google's style guide recommends
    // JS string literals use single quotes.
    const lines = string.split(/\n/g).map(this.quote_);
    return lines.join(" + '\\n' +\n");
  }

  /**
   * Common tasks for generating JavaScript from blocks.
   * Handles comments for the specified block and any connected value blocks.
   * Calls any statements following this block.
   *
   * @param block The current block.
   * @param code The JavaScript code created for this block.
   * @param thisOnly True to generate code for only this statement.
   * @returns JavaScript code with comments and subsequent blocks added.
   */
  override scrub_(
    block: Blockly.Block,
    code: string,
    thisOnly = false,
  ): string {
    let commentCode = '';
    // Only collect comments for blocks that aren't inline.
    if (!block.outputConnection || !block.outputConnection.targetConnection) {
      // Collect comment for this block.
      let comment = block.getCommentText();
      if (comment) {
        comment = stringUtils.wrap(comment, this.COMMENT_WRAP - 3);
        commentCode += this.prefixLines(comment + '\n', '// ');
      }
      // Collect comments for all value arguments.
      // Don't collect comments for nested statements.
      for (let i = 0; i < block.inputList.length; i++) {
        if (block.inputList[i].type === inputTypes.VALUE) {
          const childBlock = block.inputList[i].connection!.targetBlock();
          if (childBlock) {
            comment = this.allNestedComments(childBlock);
            if (comment) {
              commentCode += this.prefixLines(comment, '// ');
            }
          }
        }
      }
    }
    const nextBlock =
      block.nextConnection && block.nextConnection.targetBlock();
    const nextCode = thisOnly ? '' : this.blockToCode(nextBlock);
    return commentCode + code + nextCode;
  }

  /**
   * Generate code representing the specified value input, adjusted to take into
   * account indexing (zero- or one-based) and optionally by a specified delta
   * and/or by negation.
   *
   * @param block The block.
   * @param atId The ID of the input block to get (and adjust) the value of.
   * @param delta Value to add.
   * @param negate Whether to negate the value.
   * @param order The highest order acting on this value.
   * @returns The adjusted value or code that evaluates to it.
   */
  getAdjusted(
    block: Blockly.Block,
    atId: string,
    delta = 0,
    negate = false,
    order = Order.NONE,
  ): string {
    if (block.workspace.options.oneBasedIndex) {
      delta--;
    }
    const defaultAtIndex = block.workspace.options.oneBasedIndex ? '1' : '0';

    let orderForInput = order;
    if (delta > 0) {
      orderForInput = Order.ADDITION;
    } else if (delta < 0) {
      orderForInput = Order.SUBTRACTION;
    } else if (negate) {
      orderForInput = Order.UNARY_NEGATION;
    }

    let at = this.valueToCode(block, atId, orderForInput) || defaultAtIndex;

    // Easy case: no adjustments.
    if (delta === 0 && !negate) {
      return at;
    }
    // If the index is a naked number, adjust it right now.
    if (stringUtils.isNumber(at)) {
      at = String(Number(at) + delta);
      if (negate) {
        at = String(-Number(at));
      }
      return at;
    }
    // If the index is dynamic, adjust it in code.
    if (delta > 0) {
      at = `${at} + ${delta}`;
    } else if (delta < 0) {
      at = `${at} - ${-delta}`;
    }
    if (negate) {
      at = delta ? `-(${at})` : `-${at}`;
    }
    if (Math.floor(order) >= Math.floor(orderForInput)) {
      at = `(${at})`;
    }
    return at;
  }

  addMacro(tag, code, overwrite = false) {
    if (this.codeDict['macros'][tag] === undefined || overwrite) {
      this.codeDict['macros'][tag] = code;
    }
  }

  addLibrary(tag, code, overwrite = false) {
    if (this.codeDict['libraries'][tag] === undefined || overwrite) {
      this.codeDict['libraries'][tag] = code;
    }
  }

  addVariable(tag, code, overwrite = false) {
    if (this.codeDict['variables'][tag] === undefined || overwrite) {
      this.codeDict['variables'][tag] = code;
    }
  }

  addObject(tag, code, overwrite = false) {
    if (this.codeDict['objects'][tag] === undefined || overwrite) {
      this.codeDict['objects'][tag] = code;
    }
  }

  addFunction(tag, code, overwrite = false) {
    if (this.codeDict['functions'][tag] === undefined || overwrite) {
      this.codeDict['functions'][tag] = code;
    }
  }

  addSetupBegin(tag, code, overwrite = false) {
    if (this.codeDict['setups_begin'][tag] === undefined || overwrite) {
      this.codeDict['setups_begin'][tag] = code;
    }
  }

  addSetup(tag, code, overwrite = false) {
    if (this.codeDict['setups'][tag] === undefined || overwrite) {
      this.codeDict['setups'][tag] = code;
    }
  }

  addSetupEnd(tag, code, overwrite = false) {
    if (this.codeDict['setups_end'][tag] === undefined || overwrite) {
      this.codeDict['setups_end'][tag] = code;
    }
  }

  addLoopBegin(tag, code, overwrite = false) {
    if (this.codeDict['loops_begin'][tag] === undefined || overwrite) {
      this.codeDict['loops_begin'][tag] = code;
    }
  }

  addLoop(tag, code, overwrite = false) {
    if (this.codeDict['loops'][tag] === undefined || overwrite) {
      this.codeDict['loops'][tag] = code;
    }
  }

  addLoopEnd(tag, code, overwrite = false) {
    if (this.codeDict['loops_end'][tag] === undefined || overwrite) {
      this.codeDict['loops_end'][tag] = code;
    }
  }

  // 变量相关
  variableTypes = {};
  getVarType(varName) {
    if (this.variableTypes[varName]) {
      return this.variableTypes[varName];
    }
    return 'int';
  }

  setVarType(varName, type) {
    this.variableTypes[varName] = type;
  }

  getValue(block, name: string, type = '') {
    let code = '?';
    if (type == 'input_statement' || type == 'input_value') {
      try {
        code = arduinoGenerator.statementToCode(block, name);
        return code.replace(/(^\s*)/, '');
      } catch (error) {
        code = arduinoGenerator.valueToCode(block, name, Order.ATOMIC);
        return code;
      }
    }
    if (type == 'field_variable') {
      code = arduinoGenerator.nameDB_.getName(
        block.getFieldValue(name),
        'VARIABLE',
      );
      return code;
    }
    // if (type == 'field_dropdown' || type == 'field_number' || type == 'field_multilinetext') {
    code = block.getFieldValue(name);
    return code;
  }

  varIsGlobal(block) {
    let currentBlock = block;
    while (currentBlock.parentBlock_ != null) {
      currentBlock = currentBlock.parentBlock_;
      if (currentBlock.type == 'arduino_setup') {
        return true;
      }
    }
    return false;
  }

  /**
   * 记录代码片段和对应的block ID映射关系
   * @param code 代码片段
   * @param blockId block的ID
   */
  recordCodeMapping(code: string, blockId: string) {
    if (!this.blockToCodeMap.has(blockId)) {
      this.blockToCodeMap.set(blockId, []);
    }
    this.blockToCodeMap.get(blockId)!.push(code);
  }

  /**
   * 创建代码副本，将每行代码与对应的block ID关联
   * @param finalCode 最终生成的完整代码
   */
  createCodeCopy(finalCode: string) {
    this.codeCopy = [];
    const lines = finalCode.split('\n');
    
    for (const line of lines) {
      if (line.trim()) { // 只处理非空行
        let matchedBlockId = 'system'; // 默认为系统生成的代码
        let bestMatch = '';
        
        // 尝试在 blockToCodeMap 中找到最匹配的代码片段
        for (const [blockId, codeSegments] of this.blockToCodeMap) {
          for (const segment of codeSegments) {
            const trimmedSegment = segment.trim();
            const trimmedLine = line.trim();
            
            // 精确匹配或者代码片段包含当前行
            if (trimmedLine === trimmedSegment || 
                (trimmedSegment.includes(trimmedLine) && trimmedLine.length > bestMatch.length)) {
              matchedBlockId = blockId;
              bestMatch = trimmedLine;
            }
            // 如果当前行包含代码片段（处理多行代码的情况）
            else if (trimmedLine.includes(trimmedSegment) && trimmedSegment.length > bestMatch.length) {
              matchedBlockId = blockId;
              bestMatch = trimmedSegment;
            }
          }
        }
        
        this.codeCopy.push({
          text: line,
          id: matchedBlockId
        });
      }
    }
  }

  /**
   * 获取代码副本数据
   * @returns 代码副本数组，格式为 [{text: string, id: string}, ...]
   */
  getCodeCopy(): Array<{text: string, id: string}> {
    return this.codeCopy;
  }

  /**
   * 获取格式化的代码副本信息（用于调试和展示）
   * @returns 包含统计信息的格式化字符串
   */
  getCodeCopyInfo(): string {
    const totalLines = this.codeCopy.length;
    const blockIds = new Set(this.codeCopy.map(item => item.id));
    const uniqueBlocks = blockIds.size;
    
    let info = `代码副本信息:\n`;
    info += `总行数: ${totalLines}\n`;
    info += `涉及的block数量: ${uniqueBlocks}\n`;
    info += `Block映射信息: ${this.blockToCodeMap.size}个blocks有代码生成\n`;
    info += `Block ID统计:\n`;
    
    const blockStats = new Map<string, number>();
    this.codeCopy.forEach(item => {
      blockStats.set(item.id, (blockStats.get(item.id) || 0) + 1);
    });
    
    blockStats.forEach((count, blockId) => {
      info += `  - ${blockId}: ${count}行\n`;
    });
    
    return info;
  }

  /**
   * 获取详细的block到代码映射信息（用于调试）
   * @returns 详细映射信息
   */
  getBlockMappingDebugInfo(): string {
    let info = `Block到代码映射详情:\n`;
    this.blockToCodeMap.forEach((codeSegments, blockId) => {
      info += `ID： ${blockId}:\n`;
      codeSegments.forEach((code, index) => {
        info += `  ${index + 1}. "${code}"\n`;
      });
    });
    return info;
  }
}


export const arduinoGenerator = new ArduinoGenerator();
