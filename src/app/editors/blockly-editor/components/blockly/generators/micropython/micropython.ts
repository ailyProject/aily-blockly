import * as Blockly from 'blockly';

export enum Order {
  ATOMIC = 0,           // 0 literals, identifiers
  COLLECTION = 1,       // tuples, lists, dicts
  STRING_CONVERSION = 1, // `expressions`
  MEMBER = 2.1,         // obj.attr
  FUNCTION_CALL = 2.2,  // func()
  INDEX = 2.3,          // obj[index]
  POWER = 3,            // **
  UNARY_SIGN = 4,       // +, -
  BITWISE_NOT = 4,      // ~
  MULTIPLICATIVE = 5,   // *, /, //, %
  ADDITIVE = 6,         // +, -
  BITWISE_SHIFT = 7,    // <<, >>
  BITWISE_AND = 8,      // &
  BITWISE_XOR = 9,      // ^
  BITWISE_OR = 10,      // |
  RELATIONAL = 11,      // in, not in, is, is not, <, <=, >, >=, <>, !=, ==
  LOGICAL_NOT = 12,     // not
  LOGICAL_AND = 13,     // and
  LOGICAL_OR = 14,      // or
  CONDITIONAL = 15,     // if else
  LAMBDA = 16,          // lambda
  NONE = 99,           // (...)
}

const stringUtils = Blockly.utils.string;
const inputTypes = Blockly.inputs.inputTypes;

export class MicroPythonGenerator extends Blockly.CodeGenerator {
  codeDict = {};

  /** @param name Name of the language the generator is for. */
  constructor(name = 'MicroPython') {
    super(name);
    this.isInitialized = false;

    for (const key in Order) {
      const value = Order[key];
      if (typeof value === 'string') continue;
      (this as unknown as Record<string, Order>)['ORDER_' + key] = value;
    }

    this.addReservedWords(
      'False,None,True,and,as,assert,break,class,continue,def,del,elif,else,' +
      'except,finally,for,from,global,if,import,in,is,lambda,nonlocal,not,' +
      'or,pass,raise,return,try,while,with,yield,' +
      'machine,utime,ubinascii,uctypes,uhashlib,uheapq,uio,ujson,uos,ure,' +
      'uselect,usocket,ustruct,uzlib,gc,micropython,network,bluetooth,esp,' +
      'esp32,pyb,stm,wipy,Pin,PWM,ADC,UART,SPI,I2C,Timer,WDT,RTC,TouchPad,' +
      'abs,all,any,ascii,bin,bool,bytearray,bytes,callable,chr,classmethod,' +
      'compile,complex,delattr,dict,dir,divmod,enumerate,eval,exec,filter,' +
      'float,format,frozenset,getattr,globals,hasattr,hash,help,hex,id,' +
      'input,int,isinstance,issubclass,iter,len,list,locals,map,max,' +
      'memoryview,min,next,object,oct,open,ord,pow,print,property,range,' +
      'repr,reversed,round,set,setattr,slice,sorted,staticmethod,str,sum,' +
      'super,tuple,type,vars,zip',
    );
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

    // codeDict主要是为了防止代码重复生成
    this.codeDict = {};
    // 导入模块
    this.codeDict['imports'] = Object.create(null);
    // 变量
    this.codeDict['variables'] = Object.create(null);
    // 函数
    this.codeDict['functions'] = Object.create(null);
    // setup初始化代码
    this.codeDict['setups'] = Object.create(null);
    // 用户自定义setup开始
    this.codeDict['setups_begin'] = Object.create(null);
    // 用户自定义setup结束
    this.codeDict['setups_end'] = Object.create(null);
    // loop主循环代码
    this.codeDict['loops'] = Object.create(null);
    // 用户自定义loop开始
    this.codeDict['loops_begin'] = Object.create(null);
    // 用户自定义loop结束
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
    this.nameDB_!.reset();

    // 提取代码
    let imports = [];
    let variables = [];
    let functions = [];
    let setups = [];
    let setups_begin = [];
    let setups_end = [];
    let loops = [];
    let loops_begin = [];
    let loops_end = [];

    for (const key in this.codeDict['imports']) {
      imports.push(this.codeDict['imports'][key]);
    }
    for (const key in this.codeDict['variables']) {
      variables.push(this.codeDict['variables'][key]);
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

    let newcode = '';
    
    // 添加导入模块
    if (imports.length > 0) {
      newcode += `${imports.join('\n')}\n\n`;
    }

    // 添加变量定义
    if (variables.length > 0) {
      newcode += `# 全局变量\n${variables.join('\n')}\n\n`;
    }

    // 添加函数定义
    if (functions.length > 0) {
      newcode += `${functions.join('\n\n')}\n\n`;
    }

    // 添加初始化代码
    if (setups.length > 0 || setups_begin.length > 0 || setups_end.length > 0) {
      newcode += `# 初始化\n`;
      if (setups_begin.length > 0) {
        newcode += `${setups_begin.join('\n')}\n`;
      }
      if (setups.length > 0) {
        newcode += `${setups.join('\n')}\n`;
      }
      if (setups_end.length > 0) {
        newcode += `${setups_end.join('\n')}\n`;
      }
      newcode += `\n`;
    }

    // 添加主循环
    if (loops.length > 0 || loops_begin.length > 0 || loops_end.length > 0 || code.trim()) {
      newcode += `# 主循环\n`;
      newcode += `try:\n`;
      newcode += `    while True:\n`;
      
      if (loops_begin.length > 0) {
        newcode += `        ${loops_begin.join('\n        ')}\n`;
      }
      if (loops.length > 0) {
        newcode += `        ${loops.join('\n        ')}\n`;
      }
      if (loops_end.length > 0) {
        newcode += `        ${loops_end.join('\n        ')}\n`;
      }
      if (code.trim()) {
        const userCode = code.split('\n').map(line => line ? '        ' + line : '').join('\n');
        newcode += userCode;
      }
      
      newcode += `except KeyboardInterrupt:\n`;
      newcode += `    print("程序已停止")`;
    } else if (code.trim()) {
      newcode += code;
    }

    return newcode;
  }

  /**
   * Naked values are top-level blocks with outputs that aren't plugged into
   * anything. In Python, we can just leave them as expressions.
   *
   * @param line Line of generated code.
   * @returns Legal line of code.
   */
  override scrubNakedValue(line: string): string {
    return line + '\n';
  }

  /**
   * Encode a string as a properly escaped Python string, complete with
   * quotes.
   *
   * @param string Text to encode.
   * @returns Python string.
   */
  quote_(string: string): string {
    string = string
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/'/g, "\\'");
    return "'" + string + "'";
  }

  /**
   * Encode a string as a properly escaped multiline Python string, complete
   * with quotes.
   * @param string Text to encode.
   * @returns Python string.
   */
  multiline_quote_(string: string): string {
    const lines = string.split(/\n/g).map(this.quote_);
    return lines.join(" + '\\n' +\\\n");
  }

  /**
   * Common tasks for generating Python from blocks.
   * Handles comments for the specified block and any connected value blocks.
   * Calls any statements following this block.
   *
   * @param block The current block.
   * @param code The Python code created for this block.
   * @param thisOnly True to generate code for only this statement.
   * @returns Python code with comments and subsequent blocks added.
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
        commentCode += this.prefixLines(comment + '\n', '# ');
      }
      // Collect comments for all value arguments.
      // Don't collect comments for nested statements.
      for (let i = 0; i < block.inputList.length; i++) {
        if (block.inputList[i].type === inputTypes.VALUE) {
          const childBlock = block.inputList[i].connection!.targetBlock();
          if (childBlock) {
            comment = this.allNestedComments(childBlock);
            if (comment) {
              commentCode += this.prefixLines(comment, '# ');
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
      orderForInput = Order.ADDITIVE;
    } else if (delta < 0) {
      orderForInput = Order.ADDITIVE;
    } else if (negate) {
      orderForInput = Order.UNARY_SIGN;
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

  addImport(tag, code, overwrite = false) {
    if (this.codeDict['imports'][tag] === undefined || overwrite) {
      this.codeDict['imports'][tag] = code;
    }
  }

  addVariable(tag, code, overwrite = false) {
    if (this.codeDict['variables'][tag] === undefined || overwrite) {
      this.codeDict['variables'][tag] = code;
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
    return 'any';
  }

  setVarType(varName, type) {
    this.variableTypes[varName] = type;
  }

  getValue(block, name: string, type = '') {
    let code = '?';
    if (type == 'input_statement' || type == 'input_value') {
      try {
        code = micropythonGenerator.statementToCode(block, name);
        return code.replace(/(^\s*)/, '');
      } catch (error) {
        code = micropythonGenerator.valueToCode(block, name, Order.ATOMIC);
        return code;
      }
    }
    if (type == 'field_variable') {
      code = micropythonGenerator.nameDB_.getName(
        block.getFieldValue(name),
        'VARIABLE',
      );
      return code;
    }
    code = block.getFieldValue(name);
    return code;
  }

  varIsGlobal(block) {
    let currentBlock = block;
    while (currentBlock.getParent() != null) {
      currentBlock = currentBlock.getParent();
      if (currentBlock.type == 'micropython_setup') {
        return true;
      }
    }
    return false;
  }
}

export const micropythonGenerator = new MicroPythonGenerator();
