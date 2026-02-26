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
 * 代码行范围，用于 block → code 映射
 */
export interface CodeLineRange {
  startLine: number;
  endLine: number;
  startColumn?: number;  // 1-based, 用于值块行内高亮
  endColumn?: number;    // 1-based, 用于值块行内高亮
}

/**
 * 代码片段记录，记录某个 block 向某个区段( section )贡献了什么代码
 */
export interface CodeFragment {
  section: string;  // macros | libraries | variables | objects | functions | setups_begin | setups | setups_end | loops_begin | loops | loops_end | body
  tag: string;      // codeDict 中的 key（对 body 代码无 tag）
  code: string;     // 实际代码内容
}

/**
 * Block 代码映射项：一个 block 对应的全部代码信息
 */
export interface BlockCodeMapping {
  blockId: string;
  blockType: string;
  fragments: CodeFragment[];   // 该 block 贡献的所有代码片段
  lineRanges: CodeLineRange[]; // 在最终生成代码中的行号范围（finish 后计算）
  codeSnippet: string;         // 合并后的代码片段文本（便于 agent 直接使用）
}

export class ArduinoGenerator extends Blockly.CodeGenerator {
  codeDict = {};

  // ==================== Block-to-Code 追踪系统 ====================
  /** 当前正在生成代码的 block id 栈（支持嵌套） */
  private _blockIdStack: string[] = [];
  /** 每个 block 贡献的代码片段 */
  blockCodeFragments = new Map<string, CodeFragment[]>();
  /** 每个 block 的类型 */
  private _blockTypes = new Map<string, string>();
  /** codeDict 中 tag → blockId 的反向映射（用于 finish 中计算行号） */
  private _tagToBlockIds = new Map<string, Set<string>>();
  /** 每个 block 在 scrub_ 中产生的 body 代码（直接返回，不经过 addXxx） */
  private _blockBodyCode = new Map<string, string>();
  /** 值块（有 outputConnection 的块）ID 集合 */
  private _valueBlockIds = new Set<string>();
  /** 值块 → 实际输入父块 ID 映射（通过 Blockly block.outputConnection 获取真实父块） */
  private _blockParent = new Map<string, string>();
  /** 值块最终被父块使用的代码字符串（由 valueToCode 捕获，可能包含括号包裹） */
  private _valueBlockCode = new Map<string, string>();
  /** 最终的 blockId → 行号映射结果（每次 finish 后更新） */
  blockCodeMap = new Map<string, BlockCodeMapping>();

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

    // 重置 block-to-code 追踪数据
    this._blockIdStack = [];
    this.blockCodeFragments.clear();
    this._blockTypes.clear();
    this._tagToBlockIds.clear();
    this._blockBodyCode.clear();
    this._valueBlockIds.clear();
    this._blockParent.clear();
    this._valueBlockCode.clear();
    this.blockCodeMap.clear();

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

    // 提取代码（同时保留 tag 以便追踪 block 映射）
    let macros: {tag: string; code: string}[] = [];
    let libraries: {tag: string; code: string}[] = [];
    let variables: {tag: string; code: string}[] = [];
    let objects: {tag: string; code: string}[] = [];
    let functions: {tag: string; code: string}[] = [];
    let setups: {tag: string; code: string}[] = [];
    let setups_begin: {tag: string; code: string}[] = [];
    let setups_end: {tag: string; code: string}[] = [];
    let loops: {tag: string; code: string}[] = [];
    let loops_begin: {tag: string; code: string}[] = [];
    let loops_end: {tag: string; code: string}[] = [];

    for (const key in this.codeDict['macros']) {
      macros.push({tag: 'macros:' + key, code: this.codeDict['macros'][key]});
    }
    for (const key in this.codeDict['libraries']) {
      libraries.push({tag: 'libraries:' + key, code: this.codeDict['libraries'][key]});
    }
    for (const key in this.codeDict['variables']) {
      variables.push({tag: 'variables:' + key, code: this.codeDict['variables'][key]});
    }
    for (const key in this.codeDict['objects']) {
      objects.push({tag: 'objects:' + key, code: this.codeDict['objects'][key]});
    }
    for (const key in this.codeDict['functions']) {
      functions.push({tag: 'functions:' + key, code: this.codeDict['functions'][key]});
    }
    for (const key in this.codeDict['setups_begin']) {
      setups_begin.push({tag: 'setups_begin:' + key, code: this.codeDict['setups_begin'][key]});
    }
    for (const key in this.codeDict['setups_end']) {
      setups_end.push({tag: 'setups_end:' + key, code: this.codeDict['setups_end'][key]});
    }
    for (const key in this.codeDict['setups']) {
      setups.push({tag: 'setups:' + key, code: this.codeDict['setups'][key]});
    }
    for (const key in this.codeDict['loops_begin']) {
      loops_begin.push({tag: 'loops_begin:' + key, code: this.codeDict['loops_begin'][key]});
    }
    for (const key in this.codeDict['loops_end']) {
      loops_end.push({tag: 'loops_end:' + key, code: this.codeDict['loops_end'][key]});
    }
    for (const key in this.codeDict['loops']) {
      loops.push({tag: 'loops:' + key, code: this.codeDict['loops'][key]});
    }

    this.isInitialized = false;

    // 原始代码生成（保持完全向后兼容）
    let newcode =
      `#include <Arduino.h>\n\n` +
      (macros.length > 0 ? `${macros.map(m => m.code).join('\n')}\n\n` : '') +
      (libraries.length > 0 ? `${libraries.map(m => m.code).join('\n')}\n\n` : '') +
      (variables.length > 0 ? `${variables.map(m => m.code).join('\n')}\n\n` : '') +
      (objects.length > 0 ? `${objects.map(m => m.code).join('\n')}\n\n` : '') +
      (functions.length > 0 ? `${functions.map(m => m.code).join('\n')}\n\n` : '') +
      `void setup() {\n` +
      (setups_begin.length > 0 ? `  ${setups_begin.map(m => m.code).join('\n  ')}\n` : '') + '\n' +
      (setups.length > 0 ? `${setups.map(m => m.code).join('\n  ')}\n` : '') +
      (setups_end.length > 0 ? `    ${setups_end.map(m => m.code).join('\n  ')}\n` : '') +
      `}\n\n` +
      `void loop() {\n` +
      (loops_begin.length > 0 ? `  ${loops_begin.map(m => m.code).join('\n  ')}\n` : '') + '\n' +
      (loops.length > 0 ? `${loops.map(m => m.code).join('\n  ')}\n` : '') +
      (loops_end.length > 0 ? `  ${loops_end.map(m => m.code).join('\n  ')}\n` : '') +
      `}`;

    // ==================== 构建 block → 行号映射 ====================
    try {
      this._buildBlockCodeMap(newcode, {
        macros, libraries, variables, objects, functions,
        setups_begin, setups, setups_end,
        loops_begin, loops, loops_end
      });
    } catch (e) {
      console.warn('构建 block-to-code 映射失败:', e);
    }

    return newcode;
  }

  /**
   * 构建 blockId → 代码行号 映射
   * 通过在最终代码中搜索每个 tag 对应的代码片段来确定行号
   */
  private _buildBlockCodeMap(
    finalCode: string,
    sections: Record<string, {tag: string; code: string}[]>
  ): void {
    const lines = finalCode.split('\n');

    // tag → 行号范围
    const tagLineRanges = new Map<string, CodeLineRange>();

    // 对每个 section 的每个 tag，在最终代码中找它的行号范围
    for (const sectionName of Object.keys(sections)) {
      const items = sections[sectionName];
      for (const item of items) {
        const codeLines = item.code.split('\n');
        const firstLine = codeLines[0].trim();
        if (!firstLine) continue;

        // 在最终代码中搜索该片段首行
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim() === firstLine) {
            // 验证后续行也匹配
            let match = true;
            for (let j = 1; j < codeLines.length; j++) {
              if (i + j >= lines.length || lines[i + j].trim() !== codeLines[j].trim()) {
                match = false;
                break;
              }
            }
            if (match) {
              tagLineRanges.set(item.tag, {
                startLine: i + 1,  // 1-based
                endLine: i + codeLines.length  // 1-based, inclusive
              });
              break;
            }
          }
        }
      }
    }

    // 为每个 blockId 聚合行号范围
    this.blockCodeMap.clear();

    // ===== Part 1: 处理 addXxx 产生的代码片段（codeDict 区段） =====
    for (const [blockId, fragments] of this.blockCodeFragments.entries()) {
      const lineRanges: CodeLineRange[] = [];
      const codeSnippets: string[] = [];

      for (const fragment of fragments) {
        const fullTag = fragment.section + ':' + fragment.tag;
        const range = tagLineRanges.get(fullTag);
        if (range) {
          lineRanges.push(range);
          const snippet = lines.slice(range.startLine - 1, range.endLine).join('\n');
          codeSnippets.push(snippet);
        }
      }

      const mergedRanges = this._mergeLineRanges(lineRanges);

      if (mergedRanges.length > 0) {
        this.blockCodeMap.set(blockId, {
          blockId,
          blockType: this._blockTypes.get(blockId) || 'unknown',
          fragments,
          lineRanges: mergedRanges,
          codeSnippet: codeSnippets.join('\n\n')
        });
      }
    }

    // ===== Part 2: 处理 body 代码（块直接返回的代码，不经过 addXxx） =====
    // 这些代码最终被容器块（arduino_setup/loop）收集后通过 addSetup/addLoop 注入
    // 记录已占用的行号，防止重复代码匹配到同一行
    const usedLines = new Set<number>();
    for (const [blockId, bodyCode] of this._blockBodyCode.entries()) {
      // 跳过值块 - 由 Part 3 以列级精度处理
      if (this._valueBlockIds.has(blockId)) continue;

      const codeClean = bodyCode.replace(/\n+$/, '');
      if (!codeClean.trim()) continue;

      const bodyLines = codeClean.split('\n');
      // 找到第一行有效代码
      const firstSigLine = bodyLines.find(l => l.trim())?.trim();
      if (!firstSigLine) continue;

      // 在最终代码中查找该行（跳过已被其他块占用的行）
      let matchedRange: CodeLineRange | null = null;
      for (let i = 0; i < lines.length; i++) {
        if (usedLines.has(i)) continue;
        if (lines[i].trim() !== firstSigLine) continue;

        // 对于多行 body 代码，验证后续行是否也匹配
        if (bodyLines.length > 1) {
          let verified = true;
          let lastMatchedIdx = i;
          let sigSearchIdx = 0;
          // 跳过 bodyLines 开头空行
          while (sigSearchIdx < bodyLines.length && !bodyLines[sigSearchIdx].trim()) sigSearchIdx++;
          sigSearchIdx++; // 跳过已匹配的第一行

          let finalSearchIdx = i + 1;
          while (sigSearchIdx < bodyLines.length && finalSearchIdx < lines.length) {
            const bodySig = bodyLines[sigSearchIdx].trim();
            if (!bodySig) {
              sigSearchIdx++;
              continue;
            }
            if (lines[finalSearchIdx].trim() === bodySig) {
              lastMatchedIdx = finalSearchIdx;
              sigSearchIdx++;
              finalSearchIdx++;
            } else {
              finalSearchIdx++;
              // 允许一定的搜索窗口（最多超出 bodyLines 长度的 50%）
              if (finalSearchIdx > i + bodyLines.length * 1.5) {
                verified = false;
                break;
              }
            }
          }

          if (verified && sigSearchIdx >= bodyLines.length) {
            matchedRange = {
              startLine: i + 1,
              endLine: lastMatchedIdx + 1
            };
          }
        } else {
          // 单行匹配
          matchedRange = { startLine: i + 1, endLine: i + 1 };
        }

        if (matchedRange) break;
      }

      if (!matchedRange) continue;

      // 标记已占用的行
      for (let ln = matchedRange.startLine - 1; ln < matchedRange.endLine; ln++) {
        usedLines.add(ln);
      }

      // 合并到 blockCodeMap
      if (this.blockCodeMap.has(blockId)) {
        const existing = this.blockCodeMap.get(blockId)!;
        existing.lineRanges.push(matchedRange);
        existing.lineRanges = this._mergeLineRanges(existing.lineRanges);
        const bodySnippet = lines.slice(matchedRange.startLine - 1, matchedRange.endLine).join('\n');
        existing.codeSnippet += '\n\n' + bodySnippet;
      } else {
        const bodySnippet = lines.slice(matchedRange.startLine - 1, matchedRange.endLine).join('\n');
        this.blockCodeMap.set(blockId, {
          blockId,
          blockType: this._blockTypes.get(blockId) || 'unknown',
          fragments: [{ section: 'body', tag: blockId, code: codeClean }],
          lineRanges: [matchedRange],
          codeSnippet: bodySnippet
        });
      }
    }

    // ===== Part 3: 处理值块的行内代码（列级精度高亮） =====
    // 策略：从已映射的父块出发，在父块的代码行内定位其子值块的精确列位置
    // 使用 valueToCode 捕获的精确代码（_valueBlockCode）而非 _blockBodyCode

    // 构建反向索引：parentId → [{blockId, code}, ...]
    const parentToValueChildren = new Map<string, {blockId: string, code: string}[]>();
    for (const valueBlockId of this._valueBlockIds) {
      if (this.blockCodeMap.has(valueBlockId)) continue;
      const parentId = this._blockParent.get(valueBlockId);
      if (!parentId) continue;
      // 优先使用 valueToCode 捕获的代码（包含父块可能添加的括号等），
      // 回退到 _blockBodyCode
      const code = this._valueBlockCode.get(valueBlockId)
                || this._blockBodyCode.get(valueBlockId);
      if (!code || !code.trim()) continue;
      if (!parentToValueChildren.has(parentId)) {
        parentToValueChildren.set(parentId, []);
      }
      parentToValueChildren.get(parentId)!.push({ blockId: valueBlockId, code: code.trim() });
    }

    // 每个父块独立追踪已占用位置，避免不同父块之间干扰
    // 多轮处理：值块的父块可能也是值块，需要先映射父块再映射子块
    let progress = true;
    while (progress) {
      progress = false;
      for (const [parentId, children] of parentToValueChildren.entries()) {
        const parentMapping = this.blockCodeMap.get(parentId);
        if (!parentMapping || parentMapping.lineRanges.length === 0) continue;

        // 每个父块独立的已占用位置跟踪
        const parentUsed = new Set<string>();

        for (const child of children) {
          if (this.blockCodeMap.has(child.blockId)) continue;

          // 在父块的精确行范围内搜索值块代码
          let matchedRange: CodeLineRange | null = null;
          for (const r of parentMapping.lineRanges) {
            for (let ln = r.startLine - 1; ln < r.endLine; ln++) {
              if (ln >= lines.length) continue;
              let searchFrom = 0;
              while (searchFrom < lines[ln].length) {
                const col = lines[ln].indexOf(child.code, searchFrom);
                if (col === -1) break;
                const posKey = `${ln}:${col}`;
                if (!parentUsed.has(posKey)) {
                  matchedRange = {
                    startLine: ln + 1,
                    endLine: ln + 1,
                    startColumn: col + 1,
                    endColumn: col + 1 + child.code.length
                  };
                  parentUsed.add(posKey);
                  break;
                }
                searchFrom = col + 1;
              }
              if (matchedRange) break;
            }
            if (matchedRange) break;
          }

          if (matchedRange) {
            this.blockCodeMap.set(child.blockId, {
              blockId: child.blockId,
              blockType: this._blockTypes.get(child.blockId) || 'unknown',
              fragments: [{ section: 'value', tag: child.blockId, code: child.code }],
              lineRanges: [matchedRange],
              codeSnippet: child.code
            });
            progress = true;
          }
        }
      }
    }
  }

  /**
   * 合并重叠或相邻的行号范围
   */
  private _mergeLineRanges(ranges: CodeLineRange[]): CodeLineRange[] {
    if (ranges.length === 0) return [];
    const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
    const merged: CodeLineRange[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1];
      if (sorted[i].startLine <= last.endLine + 1) {
        last.endLine = Math.max(last.endLine, sorted[i].endLine);
      } else {
        merged.push({ ...sorted[i] });
      }
    }
    return merged;
  }

  /**
   * Naked values are top-level blocks with outputs that aren't plugged into
   * anything.  A trailing semicolon is needed to make this legal.
   *
   * @param line Line of generated code.
   * @returns Legal line of code.
   */
  /**
   * 重写 blockToCode：在生成前后维护 blockId 栈，实现代码追踪
   */
  override blockToCode(
    block: Blockly.Block | null,
    opt_thisOnly?: boolean
  ): string | [string, number] {
    if (!block) {
      return super.blockToCode(block, opt_thisOnly);
    }
    // 入栈当前 block
    this._blockIdStack.push(block.id);
    this._blockTypes.set(block.id, block.type);

    const result = super.blockToCode(block, opt_thisOnly);

    // 对于值块（返回 [code, order]），记录真实的输入父块关系
    if (Array.isArray(result)) {
      this._valueBlockIds.add(block.id);
      // 通过 Blockly 的 outputConnection 获取真实的输入父块（而非调用栈父块）
      const parentBlock = block.outputConnection?.targetBlock();
      if (parentBlock) {
        this._blockParent.set(block.id, parentBlock.id);
      }
    }

    // 出栈
    this._blockIdStack.pop();
    return result;
  }

  /**
   * 重写 valueToCode：捕获值块实际被使用的代码字符串和父块关系
   */
  override valueToCode(
    block: Blockly.Block,
    name: string,
    outerOrder: number
  ): string {
    const code = super.valueToCode(block, name, outerOrder);
    // 找到实际连接的值块
    const input = block.getInput(name);
    const targetBlock = input?.connection?.targetBlock();
    if (targetBlock && code) {
      this._valueBlockCode.set(targetBlock.id, code);
    }
    return code;
  }

  /**
   * 获取当前正在生成代码的 block id（栈顶）
   */
  private _getCurrentBlockId(): string | null {
    return this._blockIdStack.length > 0
      ? this._blockIdStack[this._blockIdStack.length - 1]
      : null;
  }

  /**
   * 获取当前 block id 栈中所有 id（用于同时关联父级 block）
   */
  private _getAllCurrentBlockIds(): string[] {
    return [...this._blockIdStack];
  }

  /**
   * 记录代码片段到追踪系统
   */
  private _trackCodeFragment(section: string, tag: string, code: string): void {
    const blockIds = this._getAllCurrentBlockIds();
    if (blockIds.length === 0) return;

    // 只关联到栈顶的 block（直接产生代码的那个）
    const blockId = blockIds[blockIds.length - 1];
    if (!this.blockCodeFragments.has(blockId)) {
      this.blockCodeFragments.set(blockId, []);
    }
    this.blockCodeFragments.get(blockId)!.push({ section, tag, code });

    // 记录 tag → blockId 反向映射
    const fullTag = section + ':' + tag;
    if (!this._tagToBlockIds.has(fullTag)) {
      this._tagToBlockIds.set(fullTag, new Set());
    }
    this._tagToBlockIds.get(fullTag)!.add(blockId);
  }

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
    // === 追踪 body 代码：记录每个 block 自身直接返回的代码 ===
    if (typeof code === 'string' && code.trim()) {
      this._blockBodyCode.set(block.id, code);
      this._blockTypes.set(block.id, block.type);
    }

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
    this._trackCodeFragment('macros', tag, code);
  }

  addLibrary(tag, code, overwrite = false) {
    if (this.codeDict['libraries'][tag] === undefined || overwrite) {
      this.codeDict['libraries'][tag] = code;
    }
    this._trackCodeFragment('libraries', tag, code);
  }

  addVariable(tag, code, overwrite = false) {
    if (this.codeDict['variables'][tag] === undefined || overwrite) {
      this.codeDict['variables'][tag] = code;
    }
    this._trackCodeFragment('variables', tag, code);
  }

  addObject(tag, code, overwrite = false) {
    if (this.codeDict['objects'][tag] === undefined || overwrite) {
      this.codeDict['objects'][tag] = code;
    }
    this._trackCodeFragment('objects', tag, code);
  }

  addFunction(tag, code, overwrite = false) {
    if (this.codeDict['functions'][tag] === undefined || overwrite) {
      this.codeDict['functions'][tag] = code;
    }
    this._trackCodeFragment('functions', tag, code);
  }

  addSetupBegin(tag, code, overwrite = false) {
    if (this.codeDict['setups_begin'][tag] === undefined || overwrite) {
      this.codeDict['setups_begin'][tag] = code;
    }
    this._trackCodeFragment('setups_begin', tag, code);
  }

  addSetup(tag, code, overwrite = false) {
    if (this.codeDict['setups'][tag] === undefined || overwrite) {
      this.codeDict['setups'][tag] = code;
    }
    this._trackCodeFragment('setups', tag, code);
  }

  addSetupEnd(tag, code, overwrite = false) {
    if (this.codeDict['setups_end'][tag] === undefined || overwrite) {
      this.codeDict['setups_end'][tag] = code;
    }
    this._trackCodeFragment('setups_end', tag, code);
  }

  addLoopBegin(tag, code, overwrite = false) {
    if (this.codeDict['loops_begin'][tag] === undefined || overwrite) {
      this.codeDict['loops_begin'][tag] = code;
    }
    this._trackCodeFragment('loops_begin', tag, code);
  }

  addLoop(tag, code, overwrite = false) {
    if (this.codeDict['loops'][tag] === undefined || overwrite) {
      this.codeDict['loops'][tag] = code;
    }
    this._trackCodeFragment('loops', tag, code);
  }

  addLoopEnd(tag, code, overwrite = false) {
    if (this.codeDict['loops_end'][tag] === undefined || overwrite) {
      this.codeDict['loops_end'][tag] = code;
    }
    this._trackCodeFragment('loops_end', tag, code);
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
}


export const arduinoGenerator = new ArduinoGenerator();
