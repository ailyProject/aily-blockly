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

/**
 * 代码生成事件类型定义
 */
export interface CodeGenerationEvents {
  progress: { completed: number; total: number; currentBlock?: string };
  complete: { code: string };
  error: { error: Error };
}

/**
 * 异步代码生成选项
 */
export interface AsyncCodeGenerationOptions {
  /** 是否立即返回骨架代码 */
  returnSkeleton?: boolean;
  /** 每批处理的块数量 */
  batchSize?: number;
  /** 是否启用进度通知 */
  enableProgress?: boolean;
}

/**
 * 代码生成任务
 */
interface CodeGenerationTask {
  block: Blockly.Block;
  priority: number; // 优先级，数字越小优先级越高
  depth: number; // 块深度
}

export class ArduinoGenerator extends Blockly.CodeGenerator {
  codeDict = {};

  // 异步生成相关属性
  private _isGenerating = false;
  private _generationQueue: CodeGenerationTask[] = [];
  private _generationProgress = { completed: 0, total: 0 };
  private _currentGenerationId: string | null = null;
  private _generationAbortController: AbortController | null = null;
  private _eventListeners: Map<string, Set<Function>> = new Map();
  private _processedBlocks: Set<string> = new Set();

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
      'detachInterrupt,interrupts,noInterrupts'
    );
  }

  /**
   * 事件监听器管理
   */
  private _emit(event: keyof CodeGenerationEvents, data: any): void {
    const listeners = this._eventListeners.get(event);
    if (listeners) {
      listeners.forEach((listener) => {
        try {
          listener(data);
        } catch (error) {
          console.error(`Error in event listener for ${event}:`, error);
        }
      });
    }
  }

  /**
   * 添加事件监听器
   */
  on<K extends keyof CodeGenerationEvents>(
    event: K,
    listener: (data: CodeGenerationEvents[K]) => void
  ): void {
    if (!this._eventListeners.has(event)) {
      this._eventListeners.set(event, new Set());
    }
    this._eventListeners.get(event)!.add(listener);
  }

  /**
   * 移除事件监听器
   */
  off<K extends keyof CodeGenerationEvents>(
    event: K,
    listener: (data: CodeGenerationEvents[K]) => void
  ): void {
    const listeners = this._eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * 移除所有事件监听器
   */
  removeAllListeners(event?: keyof CodeGenerationEvents): void {
    if (event) {
      this._eventListeners.delete(event);
    } else {
      this._eventListeners.clear();
    }
  }

  /**
   * 收集顶层块（不递归收集子块）
   * 子块会在 blockToCode 中自动处理
   */
  private _collectTopBlocks(workspace: Blockly.Workspace): Blockly.Block[] {
    const topBlocks = workspace.getTopBlocks(true);
    const validBlocks: Blockly.Block[] = [];

    for (let i = 0, block; (block = topBlocks[i]); i++) {
      if (block.isEnabled() && !block.isInsertionMarker()) {
        validBlocks.push(block);
      }
    }

    return validBlocks;
  }

  /**
   * 生成骨架代码（快速路径）
   * 注意：此方法不会修改生成器状态，避免影响后续完整代码生成
   */
  private _generateSkeletonCode(workspace: Blockly.Workspace): string {
    // 保存当前状态
    const savedCodeDict = JSON.parse(JSON.stringify(this.codeDict));
    const savedDefinitions = { ...this.definitions_ };

    try {
      // 临时初始化（不影响后续完整生成，因为完整生成会重新 init）
      const blocks = workspace.getTopBlocks(true);
      const blockCount = blocks.length;

      // 生成基本结构
      let skeleton = `#include <Arduino.h>\n\n`;
      skeleton += `// 代码生成中，共 ${blockCount} 个顶层块，请稍候...\n\n`;
      skeleton += `void setup() {\n  // 初始化代码\n}\n\n`;
      skeleton += `void loop() {\n  // 主循环代码\n}`;

      return skeleton;
    } finally {
      // 恢复状态（虽然完整生成会重新 init，但为了安全起见还是恢复）
      this.codeDict = savedCodeDict;
      this.definitions_ = savedDefinitions;
    }
  }

  /**
   * 异步生成代码
   */
  async workspaceToCodeAsync(
    workspace?: Blockly.Workspace,
    options: AsyncCodeGenerationOptions = {}
  ): Promise<string> {
    // 记录开始时间
    const startTime = performance.now();
    console.log('[workspaceToCodeAsync] 进度: 开始执行代码生成');

    if (!workspace) {
      console.warn(
        'No workspace specified in workspaceToCodeAsync call.  Guessing.'
      );
      workspace = Blockly.common.getMainWorkspace();
    }

    const {
      returnSkeleton = true,
      batchSize = 10,
      enableProgress = true,
    } = options;

    // 如果正在生成，取消之前的任务
    if (this._isGenerating && this._generationAbortController) {
      this._generationAbortController.abort();
    }

    // 创建新的生成任务ID
    const generationId = `${Date.now()}-${Math.random()}`;
    this._currentGenerationId = generationId;
    this._generationAbortController = new AbortController();
    const signal = this._generationAbortController.signal;

    // 重置状态
    this._isGenerating = true;
    this._generationQueue = [];
    this._processedBlocks.clear();
    this._generationProgress = { completed: 0, total: 0 };

    // 初始化生成器
    this.init(workspace);

    // 只收集顶层块，子块会在 blockToCode 中自动处理
    const topBlocks = this._collectTopBlocks(workspace);
    this._generationQueue = topBlocks.map((block) => ({
      block,
      priority: 0,
      depth: 0,
    }));
    this._generationProgress.total = this._generationQueue.length;

    // 如果启用快速路径，立即返回骨架代码
    if (returnSkeleton) {
      const skeletonCode = this._generateSkeletonCode(workspace);

      // 异步处理完整代码生成
      this._processGenerationQueue(
        generationId,
        signal,
        batchSize,
        enableProgress,
        startTime
      ).catch((error) => {
        if (error.name !== 'AbortError') {
          this._emit('error', { error });
        }
      });

      return skeletonCode;
    }
    // 否则等待完整生成
    return this._processGenerationQueue(
      generationId,
      signal,
      batchSize,
      enableProgress,
      startTime
    );
  }

  /**
   * 处理生成队列
   * 只处理顶层块，每个顶层块的完整代码（包括子块）同步生成
   */
  private async _processGenerationQueue(
    generationId: string,
    signal: AbortSignal,
    batchSize: number,
    enableProgress: boolean,
    startTime: number
  ): Promise<string> {
    const codeResults: Array<{
      block: Blockly.Block;
      code: string | [string, number];
    }> = [];

    return new Promise((resolve, reject) => {
      if (signal.aborted || this._currentGenerationId !== generationId) {
        reject(new DOMException('Generation cancelled', 'AbortError'));
        return;
      }

      const processBatch = () => {
        if (signal.aborted || this._currentGenerationId !== generationId) {
          this._isGenerating = false;
          reject(new DOMException('Generation cancelled', 'AbortError'));
          return;
        }

        let processed = 0;
        while (
          processed < batchSize &&
          this._generationQueue.length > 0 &&
          !signal.aborted
          ) {
          const task = this._generationQueue.shift()!;
          const block = task.block;

          if (this._processedBlocks.has(block.id)) {
            processed++;
            continue;
          }

          try {
            // 生成顶层块的完整代码（包括所有子块）
            // blockToCode 会递归处理所有子块，这是同步的但很快
            const blockCode = this.blockToCode(block);

            codeResults.push({ block, code: blockCode });
            this._processedBlocks.add(block.id);
            this._generationProgress.completed++;

            if (enableProgress) {
              this._emit('progress', {
                completed: this._generationProgress.completed,
                total: this._generationProgress.total,
                currentBlock: block.type,
              });
            }
          } catch (error) {
            console.error(
              `Error generating code for block ${block.id}:`,
              error
            );
            // 即使出错也标记为已处理，避免无限循环
            this._processedBlocks.add(block.id);
            this._generationProgress.completed++;
          }

          processed++;
        }

        if (this._generationQueue.length === 0) {
          // 所有顶层块处理完成，生成最终代码
          this._isGenerating = false;
          try {
            const finalCode = this._generateFinalCodeFromResults(codeResults);
            const endTime = performance.now();
            const duration = endTime - startTime;
            console.log(
              `[workspaceToCodeAsync] 进度: 代码生成完成，执行时间: ${duration.toFixed(2)}ms`
            );
            this._emit('complete', { code: finalCode });
            resolve(finalCode);
          } catch (error) {
            const endTime = performance.now();
            const duration = endTime - startTime;
            console.error(
              `[workspaceToCodeAsync] 进度: 代码生成失败，执行时间: ${duration.toFixed(2)}ms`,
              error
            );
            this._emit('error', { error: error as Error });
            reject(error);
          }
        } else {
          // 继续处理下一批
          const scheduler =
            window.requestIdleCallback ||
            ((cb: () => void) => setTimeout(cb, 0));
          scheduler(() => {
            processBatch();
          });
        }
      };

      // 开始处理第一批
      const scheduler =
        window.requestIdleCallback || ((cb: () => void) => setTimeout(cb, 0));
      scheduler(() => {
        processBatch();
      });
    });
  }

  /**
   * 从代码生成结果生成最终代码
   */
  private _generateFinalCodeFromResults(
    codeResults: Array<{
      block: Blockly.Block;
      code: string | [string, number];
    }>
  ): string {
    const code: string[] = [];

    for (const { block, code: blockCode } of codeResults) {
      let line: string | [string, number] = blockCode;

      if (Array.isArray(line)) {
        line = line[0];
      }

      if (line) {
        if (block.outputConnection) {
          line = this.scrubNakedValue(line as string);
          if (this.STATEMENT_PREFIX && !block.suppressPrefixSuffix) {
            line = this.injectId(this.STATEMENT_PREFIX, block) + line;
          }
          if (this.STATEMENT_SUFFIX && !block.suppressPrefixSuffix) {
            line = line + this.injectId(this.STATEMENT_SUFFIX, block);
          }
        }
        code.push(line as string);
      }
    }

    let codeString = code.join('\n');
    codeString = this.finish(codeString);
    codeString = codeString.replace(/^\s+\n/, '');
    codeString = codeString.replace(/\n\s+$/, '\n');
    codeString = codeString.replace(/[ \t]+\n/g, '\n');

    return codeString;
  }

  /**
   * 取消当前代码生成
   */
  cancelGeneration(): void {
    if (this._isGenerating && this._generationAbortController) {
      this._generationAbortController.abort();
      this._isGenerating = false;
      this._generationQueue = [];
      this._processedBlocks.clear();
      this._currentGenerationId = null;
    }
  }

  /**
   * 清除生成缓存
   */
  clearGenerationCache(): void {
    this._processedBlocks.clear();
    // 如果正在生成，取消当前任务
    if (this._isGenerating) {
      this.cancelGeneration();
    }
  }

  /**
   * Generate code for all blocks in the workspace to the specified language.
   *
   * @param workspace Workspace to generate code from.
   * @returns Generated code.
   */
  override workspaceToCode(workspace?: Blockly.Workspace): string {
    if (!workspace) {
      // Backwards compatibility from before there could be multiple workspaces.
      console.warn(
        'No workspace specified in workspaceToCode call.  Guessing.'
      );
      workspace = Blockly.common.getMainWorkspace();
    }
    const code = [];
    this.init(workspace);
    const blocks = workspace.getTopBlocks(true);
    for (let i = 0, block; (block = blocks[i]); i++) {
      let line = this.blockToCode(block);
      if (Array.isArray(line)) {
        // Value blocks return tuples of code and operator order.
        // Top-level blocks don't care about operator order.
        line = line[0];
      }
      if (line) {
        if (block.outputConnection) {
          // This block is a naked value.  Ask the language's code generator if
          // it wants to append a semicolon, or something.
          line = this.scrubNakedValue(line);
          if (this.STATEMENT_PREFIX && !block.suppressPrefixSuffix) {
            line = this.injectId(this.STATEMENT_PREFIX, block) + line;
          }
          if (this.STATEMENT_SUFFIX && !block.suppressPrefixSuffix) {
            line = line + this.injectId(this.STATEMENT_SUFFIX, block);
          }
        }
        code.push(line);
      }
    }
    // Blank line between each section.
    let codeString = code.join('\n');
    codeString = this.finish(codeString);
    // Final scrubbing of whitespace.
    codeString = codeString.replace(/^\s+\n/, '');
    codeString = codeString.replace(/\n\s+$/, '\n');
    codeString = codeString.replace(/[ \t]+\n/g, '\n');

    // setTimeout(() => {
    //   this.workspaceToCodeAgain(workspace);
    // }, 5000);
    return codeString;
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

    // 清除生成缓存
    this._processedBlocks.clear();

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
          Blockly.Names.NameType.DEVELOPER_VARIABLE
        )
      );
    }

    // Add user variables, but only ones that are being used.
    const variables = Blockly.Variables.allUsedVarModels(workspace);
    for (let i = 0; i < variables.length; i++) {
      defvars.push(
        this.nameDB_.getName(
          variables[i].getId(),
          Blockly.Names.NameType.VARIABLE
        )
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
      (setups_begin.length > 0 ? `  ${setups_begin.join('\n  ')}\n` : '') +
      '\n' +
      (setups.length > 0 ? `${setups.join('\n  ')}\n` : '') +
      (setups_end.length > 0 ? `    ${setups_end.join('\n  ')}\n` : '') +
      `}\n\n` +
      `void loop() {\n` +
      (loops_begin.length > 0 ? `  ${loops_begin.join('\n  ')}\n` : '') +
      '\n' +
      (loops.length > 0 ? `${loops.join('\n  ')}\n` : '') +
      (loops_end.length > 0 ? `  ${loops_end.join('\n  ')}\n` : '') +
      `}`;
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
    return '"' + string + '"';
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
   * Generate a code string representing the blocks attached to the named
   * statement input. Indent the code.
   * This is mainly used in generators. When trying to generate code to evaluate
   * look at using workspaceToCode or blockToCode.
   *
   * @param block The block containing the input.
   * @param name The name of the input.
   * @returns Generated code or '' if no blocks are connected.
   * @throws ReferenceError if the specified input does not exist.
   */
  override statementToCode(block: Blockly.Block, name: string): string {
    const targetBlock = block.getInputTargetBlock(name);
    if (!targetBlock && !block.getInput(name)) {
      throw ReferenceError(`Input "${name}" doesn't exist on "${block.type}"`);
    }
    let code = this.blockToCode(targetBlock);
    // Value blocks must return code and order of operations info.
    // Statement blocks must only return code.
    if (typeof code !== 'string') {
      throw TypeError(
        'Expecting code from statement block: ' +
        (targetBlock && targetBlock.type),
      );
    }
    if (code) {
      code = this.prefixLines(code, this.INDENT);
    }
    return code;
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
    thisOnly = false
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
   * Generate code for the specified block (and attached blocks).
   * The generator must be initialized before calling this function.
   *
   * @param block The block to generate code for.
   * @param opt_thisOnly True to generate code for only this statement.
   * @returns For statement blocks, the generated code.
   *     For value blocks, an array containing the generated code and an
   * operator order value.  Returns '' if block is null.
   */
  override blockToCode(
    block: Blockly.Block | null,
    opt_thisOnly?: boolean
  ): string | [string, number] {
    if (this.isInitialized === false) {
      console.warn(
        'CodeGenerator init was not called before blockToCode was called.'
      );
    }
    if (!block) {
      return '';
    }
    if (!block.isEnabled()) {
      // Skip past this block if it is disabled.
      return opt_thisOnly ? '' : this.blockToCode(block.getNextBlock());
    }
    if (block.isInsertionMarker()) {
      // Skip past insertion markers.
      return opt_thisOnly ? '' : this.blockToCode(block.getChildren(false)[0]);
    }

    // Look up block generator function in dictionary - but fall back
    // to looking up on this if not found, for backwards compatibility.
    const func = this.forBlock[block.type];
    if (typeof func !== 'function') {
      throw Error(
        `${this.name_} generator does not know how to generate code ` +
        `for block type "${block.type}".`
      );
    }
    // First argument to func.call is the value of 'this' in the generator.
    // Prior to 24 September 2013 'this' was the only way to access the block.
    // The current preferred method of accessing the block is through the second
    // argument to func.call, which becomes the first parameter to the
    // generator.

    let code: string | [string, number] = func.call(block, block, this);

    if (Array.isArray(code)) {
      // Value blocks return tuples of code and operator order.
      if (!block.outputConnection) {
        throw TypeError('Expecting string from statement block: ' + block.type);
      }
      return [this.scrub_(block, code[0], opt_thisOnly), code[1]];
    } else if (typeof code === 'string') {
      if (this.STATEMENT_PREFIX && !block.suppressPrefixSuffix) {
        code = this.injectId(this.STATEMENT_PREFIX, block) + code;
      }
      if (this.STATEMENT_SUFFIX && !block.suppressPrefixSuffix) {
        code = code + this.injectId(this.STATEMENT_SUFFIX, block);
      }
      return this.scrub_(block, code, opt_thisOnly);
    } else if (code === null) {
      // Block has handled code generation itself.
      return '';
    }
    throw SyntaxError('Invalid code generated: ' + code);
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
    order = Order.NONE
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
        'VARIABLE'
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
}

export const arduinoGenerator = new ArduinoGenerator();
