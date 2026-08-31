/**
 * @license
 * Copyright 2012 Google LLC
 * Copyright 2021 Google LLC
 * Copyright 2026 aily blockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Blockly from 'blockly';
import { pythonGenerator as blocklyPythonGenerator } from 'blockly/python';

/** Python operator precedence, from strongest to weakest binding. */
// prettier-ignore
export enum Order {
  ATOMIC = 0,
  COLLECTION = 1,
  STRING_CONVERSION = 1,
  MEMBER = 2.1,
  INDEX = 2.1,
  FUNCTION_CALL = 2.2,
  EXPONENTIATION = 3,
  POWER = 3,
  UNARY_SIGN = 4,
  BITWISE_NOT = 4,
  MULTIPLICATIVE = 5,
  ADDITIVE = 6,
  BITWISE_SHIFT = 7,
  BITWISE_AND = 8,
  BITWISE_XOR = 9,
  BITWISE_OR = 10,
  RELATIONAL = 11,
  LOGICAL_NOT = 12,
  LOGICAL_AND = 13,
  LOGICAL_OR = 14,
  CONDITIONAL = 15,
  LAMBDA = 16,
  NONE = 99,
}

export type PythonCodeSection =
  | 'imports'
  | 'variables'
  | 'functions'
  | 'setups_begin'
  | 'setups'
  | 'setups_end'
  | 'loops_begin'
  | 'loops'
  | 'loops_end'
  | 'cleanups';

export type PythonValueSource =
  | ''
  | 'input_statement'
  | 'input_value'
  | 'field_variable'
  | 'field';

export interface PythonGeneratorOptions {
  /** Convert Ctrl+C into a normal exit when an explicit loop section exists. */
  catchKeyboardInterrupt?: boolean;
}

type SectionStore = Record<PythonCodeSection, Map<string, string>>;

const PROCEDURE_DEFINITION_BLOCKS = new Set([
  'procedures_defnoreturn',
  'procedures_defreturn',
]);

const IMPORT_PATTERN = /^(?:from\s+\S+\s+)?import\s+\S+/;
const FUTURE_IMPORT_PATTERN = /^from\s+__future__\s+import\s+/;

function createSectionStore(): SectionStore {
  return {
    imports: new Map(),
    variables: new Map(),
    functions: new Map(),
    setups_begin: new Map(),
    setups: new Map(),
    setups_end: new Map(),
    loops_begin: new Map(),
    loops: new Map(),
    loops_end: new Map(),
    cleanups: new Map(),
  };
}

function normalizeSnippet(code: string): string {
  return code
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[\t ]*\n)+/, '')
    .replace(/(?:\n[\t ]*)+$/, '');
}

function uniqueSnippets(snippets: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const snippet of snippets) {
    const normalized = normalizeSnippet(snippet);
    if (!normalized.trim() || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function joinSnippets(snippets: readonly string[], separator = '\n'): string {
  return snippets
    .map(normalizeSnippet)
    .filter((snippet) => Boolean(snippet.trim()))
    .join(separator);
}

/**
 * Independent CPython generator used by Linux-board projects.
 *
 * It implements the Blockly CodeGenerator contract directly.  Board/library
 * generators can contribute deterministic module sections through the addXxx
 * methods without depending on the Arduino or MicroPython implementations.
 */
export class PythonGenerator extends Blockly.CodeGenerator {
  override ORDER_OVERRIDES: [Order, Order][] = [
    [Order.FUNCTION_CALL, Order.MEMBER],
    [Order.FUNCTION_CALL, Order.FUNCTION_CALL],
    [Order.MEMBER, Order.MEMBER],
    [Order.MEMBER, Order.FUNCTION_CALL],
    [Order.LOGICAL_NOT, Order.LOGICAL_NOT],
    [Order.LOGICAL_AND, Order.LOGICAL_AND],
    [Order.LOGICAL_OR, Order.LOGICAL_OR],
  ];

  /** Valid body for otherwise-empty Python suites. Set from INDENT in init. */
  PASS = '    pass\n';

  private readonly catchKeyboardInterrupt_: boolean;
  private sections_: SectionStore = createSectionStore();
  private variableTypes_ = new Map<string, string>();

  constructor();
  constructor(options: PythonGeneratorOptions);
  constructor(name: string, options?: PythonGeneratorOptions);
  constructor(
    nameOrOptions: string | PythonGeneratorOptions = 'Python',
    options: PythonGeneratorOptions = {},
  ) {
    const name = typeof nameOrOptions === 'string' ? nameOrOptions : 'Python';
    const resolvedOptions =
      typeof nameOrOptions === 'string' ? options : nameOrOptions;
    super(name);
    this.isInitialized = false;
    this.INDENT = '    ';
    this.catchKeyboardInterrupt_ =
      resolvedOptions.catchKeyboardInterrupt ?? true;

    // Keep ORDER_* properties for existing third-party block generators.
    for (const key in Order) {
      const value = Order[key];
      if (typeof value === 'string') continue;
      (this as unknown as Record<string, Order>)['ORDER_' + key] = value;
    }

    this.addReservedWords(
      'False,None,True,and,as,assert,async,await,break,class,continue,def,del,' +
        'elif,else,except,finally,for,from,global,if,import,in,is,lambda,match,' +
        'case,nonlocal,not,or,pass,raise,return,try,while,with,yield,_,' +
        'NotImplemented,Ellipsis,__debug__,__build_class__,__doc__,__import__,' +
        '__loader__,__name__,__package__,__spec__,' +
        'ArithmeticError,AssertionError,AttributeError,BaseException,' +
        'BaseExceptionGroup,BlockingIOError,BrokenPipeError,BufferError,' +
        'BytesWarning,ChildProcessError,ConnectionAbortedError,ConnectionError,' +
        'ConnectionRefusedError,ConnectionResetError,DeprecationWarning,' +
        'EOFError,EncodingWarning,EnvironmentError,Exception,ExceptionGroup,' +
        'FileExistsError,FileNotFoundError,FloatingPointError,FutureWarning,' +
        'GeneratorExit,IOError,ImportError,ImportWarning,IndentationError,' +
        'IndexError,InterruptedError,IsADirectoryError,KeyError,' +
        'KeyboardInterrupt,LookupError,MemoryError,ModuleNotFoundError,' +
        'NameError,NotADirectoryError,NotImplementedError,OSError,' +
        'OverflowError,PendingDeprecationWarning,PermissionError,' +
        'ProcessLookupError,RecursionError,ReferenceError,ResourceWarning,' +
        'RuntimeError,RuntimeWarning,StopAsyncIteration,StopIteration,' +
        'SyntaxError,SyntaxWarning,SystemError,SystemExit,TabError,TimeoutError,' +
        'TypeError,UnboundLocalError,UnicodeDecodeError,UnicodeEncodeError,' +
        'UnicodeError,UnicodeTranslateError,UnicodeWarning,UserWarning,' +
        'ValueError,Warning,ZeroDivisionError,' +
        'abs,aiter,all,anext,any,ascii,bin,bool,breakpoint,bytearray,bytes,' +
        'callable,chr,classmethod,compile,complex,copyright,credits,delattr,' +
        'dict,dir,divmod,enumerate,eval,exec,exit,filter,float,format,' +
        'frozenset,getattr,globals,hasattr,hash,help,hex,id,input,int,' +
        'isinstance,issubclass,iter,len,license,list,locals,map,max,memoryview,' +
        'min,next,object,oct,open,ord,pow,print,property,quit,range,repr,' +
        'reversed,round,set,setattr,slice,sorted,staticmethod,str,sum,super,' +
        'tuple,type,vars,zip,math,random,sys,Number',
    );
  }

  override init(workspace: Blockly.Workspace): void {
    super.init(workspace);

    this.PASS = this.INDENT + 'pass\n';
    this.sections_ = createSectionStore();
    this.variableTypes_.clear();

    if (!this.nameDB_) {
      this.nameDB_ = new Blockly.Names(this.RESERVED_WORDS_);
    } else {
      this.nameDB_.reset();
    }

    this.nameDB_.setVariableMap(workspace.getVariableMap());
    this.nameDB_.populateVariables(workspace);
    this.nameDB_.populateProcedures(workspace);

    const variableDefinitions: string[] = [];
    for (const name of Blockly.Variables.allDeveloperVariables(workspace)) {
      variableDefinitions.push(
        this.nameDB_.getName(
          name,
          Blockly.Names.NameType.DEVELOPER_VARIABLE,
        ) + ' = None',
      );
    }
    for (const variable of Blockly.Variables.allUsedVarModels(workspace)) {
      variableDefinitions.push(this.getVariableName(variable.getId()) + ' = None');
    }

    this.definitions_['variables'] = variableDefinitions.join('\n');
    this.isInitialized = true;
  }

  /**
   * Generate a module without Blockly's language-agnostic trailing-space scrub.
   * That scrub can change the value of CPython multiline string literals.
   */
  override workspaceToCode(workspace?: Blockly.Workspace): string {
    if (!workspace) {
      console.warn(
        'No workspace specified in workspaceToCode call. Guessing.',
      );
      workspace = Blockly.getMainWorkspace();
    }

    const code: string[] = [];
    this.init(workspace);
    for (const block of workspace.getTopBlocks(true)) {
      let line = this.blockToCode(block);
      if (Array.isArray(line)) line = line[0];
      if (!line) continue;

      if (block.outputConnection) {
        line = this.scrubNakedValue(line);
        if (this.STATEMENT_PREFIX && !block.suppressPrefixSuffix) {
          line = this.injectId(this.STATEMENT_PREFIX, block) + line;
        }
        if (this.STATEMENT_SUFFIX && !block.suppressPrefixSuffix) {
          line += this.injectId(this.STATEMENT_SUFFIX, block);
        }
      }
      code.push(line);
    }

    let moduleCode = this.finish(code.join('\n'));
    moduleCode = moduleCode.replace(/^\s+\n/, '');
    moduleCode = moduleCode.replace(/\n\s+$/, '\n');
    return moduleCode;
  }

  override finish(code: string): string {
    const standardVariables = this.definitions_['variables'] || '';
    const standardImports: string[] = [];
    const standardDefinitions: string[] = [];

    for (const [tag, definition] of Object.entries(this.definitions_)) {
      if (tag === 'variables' || !definition) continue;
      const normalized = normalizeSnippet(definition);
      if (IMPORT_PATTERN.test(normalized)) {
        standardImports.push(normalized);
      } else {
        standardDefinitions.push(normalized);
      }
    }

    code = super.finish(code);
    this.isInitialized = false;
    this.nameDB_?.reset();

    const imports = uniqueSnippets([
      ...this.sectionValues('imports'),
      ...standardImports,
    ]);
    const futureImports = imports.filter((item) => FUTURE_IMPORT_PATTERN.test(item));
    const regularImports = imports.filter((item) => !FUTURE_IMPORT_PATTERN.test(item));

    const variables = uniqueSnippets([
      standardVariables,
      ...this.sectionValues('variables'),
    ]);
    const definitions = uniqueSnippets([
      ...standardDefinitions,
      ...this.sectionValues('functions'),
    ]);
    const executable = this.buildExecutable(code);

    const moduleParts = [
      uniqueSnippets([...futureImports, ...regularImports]).join('\n'),
      variables.join('\n'),
      definitions.join('\n\n'),
      executable,
    ].filter(Boolean);

    return moduleParts.length ? moduleParts.join('\n\n') + '\n' : '';
  }

  override scrubNakedValue(line: string): string {
    return line + '\n';
  }

  /** Quote arbitrary text as a valid single-line Python string literal. */
  quote_(value: string): string {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let escaped = '';

    for (const character of value) {
      switch (character) {
        case '\\':
          escaped += '\\\\';
          break;
        case '\n':
          escaped += '\\n';
          break;
        case '\r':
          escaped += '\\r';
          break;
        case '\t':
          escaped += '\\t';
          break;
        case '\b':
          escaped += '\\b';
          break;
        case '\f':
          escaped += '\\f';
          break;
        case '\v':
          escaped += '\\v';
          break;
        default: {
          const codePoint = character.codePointAt(0)!;
          if (character === quote) {
            escaped += '\\' + character;
          } else if (codePoint < 0x20 || codePoint === 0x7f) {
            escaped += '\\x' + codePoint.toString(16).padStart(2, '0');
          } else {
            escaped += character;
          }
        }
      }
    }

    return quote + escaped + quote;
  }

  /** Quote multiline text without relying on triple-quote edge cases. */
  multiline_quote_(value: string): string {
    return this.quote_(value.replace(/\r\n?/g, '\n'));
  }

  override scrub_(
    block: Blockly.Block,
    code: string,
    thisOnly = false,
  ): string {
    let commentCode = '';
    if (!block.outputConnection || !block.outputConnection.targetConnection) {
      let comment = block.getCommentText();
      if (comment) {
        comment = Blockly.utils.string.wrap(comment, this.COMMENT_WRAP - 3);
        commentCode += this.prefixLines(comment + '\n', '# ');
      }

      for (const input of block.inputList) {
        if (input.type !== Blockly.inputs.inputTypes.VALUE) continue;
        const childBlock = input.connection?.targetBlock();
        if (!childBlock) continue;
        comment = this.allNestedComments(childBlock);
        if (comment) commentCode += this.prefixLines(comment, '# ');
      }
    }

    const nextBlock = block.nextConnection?.targetBlock() || null;
    const nextCode = thisOnly ? '' : this.blockToCode(nextBlock);
    return commentCode + code + nextCode;
  }

  /** Return an integer list/string index adjusted for the workspace convention. */
  getAdjustedInt(
    block: Blockly.Block,
    atId: string,
    delta = 0,
    negate = false,
  ): string | number {
    if (block.workspace.options.oneBasedIndex) delta--;
    const defaultIndex = block.workspace.options.oneBasedIndex ? '1' : '0';
    const inputOrder = delta ? Order.ADDITIVE : Order.NONE;
    let at: string | number =
      this.valueToCode(block, atId, inputOrder) || defaultIndex;

    if (Blockly.utils.string.isNumber(at)) {
      at = parseInt(at, 10) + delta;
      return negate ? -at : at;
    }

    if (delta > 0) {
      at = `int(${at} + ${delta})`;
    } else if (delta < 0) {
      at = `int(${at} - ${-delta})`;
    } else {
      at = `int(${at})`;
    }
    return negate ? '-' + at : at;
  }

  /** Backwards-compatible non-coercing index adjustment helper. */
  getAdjusted(
    block: Blockly.Block,
    atId: string,
    delta = 0,
    negate = false,
    outerOrder = Order.NONE,
  ): string {
    if (block.workspace.options.oneBasedIndex) delta--;
    const defaultIndex = block.workspace.options.oneBasedIndex ? '1' : '0';
    const inputOrder = delta ? Order.ADDITIVE : negate ? Order.UNARY_SIGN : outerOrder;
    let at = this.valueToCode(block, atId, inputOrder) || defaultIndex;

    if (delta === 0 && !negate) return at;
    if (Blockly.utils.string.isNumber(at)) {
      const adjusted = Number(at) + delta;
      const numericResult = negate ? -adjusted : adjusted;
      const numericOrder = numericResult < 0 ? Order.UNARY_SIGN : Order.ATOMIC;
      return this.parenthesizeForOrder(
        String(numericResult),
        outerOrder,
        numericOrder,
      );
    }
    if (delta > 0) at = `${at} + ${delta}`;
    if (delta < 0) at = `${at} - ${-delta}`;
    const resultOrder = negate ? Order.UNARY_SIGN : Order.ADDITIVE;
    if (negate) at = delta ? `-(${at})` : `-${at}`;
    return this.parenthesizeForOrder(at, outerOrder, resultOrder);
  }

  addImport(tag: string, code: string, overwrite = false): boolean {
    return this.addSectionCode('imports', tag, code, overwrite);
  }

  addVariable(tag: string, code: string, overwrite = false): boolean {
    return this.addSectionCode('variables', tag, code, overwrite);
  }

  addFunction(tag: string, code: string, overwrite = false): boolean {
    return this.addSectionCode('functions', tag, code, overwrite);
  }

  addSetupBegin(tag: string, code: string, overwrite = false): boolean {
    return this.addSectionCode('setups_begin', tag, code, overwrite);
  }

  addSetup(tag: string, code: string, overwrite = false): boolean {
    return this.addSectionCode('setups', tag, code, overwrite);
  }

  addSetupEnd(tag: string, code: string, overwrite = false): boolean {
    return this.addSectionCode('setups_end', tag, code, overwrite);
  }

  addLoopBegin(tag: string, code: string, overwrite = false): boolean {
    return this.addSectionCode('loops_begin', tag, code, overwrite);
  }

  addLoop(tag: string, code: string, overwrite = false): boolean {
    return this.addSectionCode('loops', tag, code, overwrite);
  }

  addLoopEnd(tag: string, code: string, overwrite = false): boolean {
    return this.addSectionCode('loops_end', tag, code, overwrite);
  }

  addCleanup(tag: string, code: string, overwrite = false): boolean {
    return this.addSectionCode('cleanups', tag, code, overwrite);
  }

  /** Add a standard Blockly definition used by a custom block generator. */
  addDefinition(tag: string, code: string, overwrite = false): boolean {
    this.assertTag(tag);
    if (Object.prototype.hasOwnProperty.call(this.definitions_, tag) && !overwrite) {
      return false;
    }
    this.definitions_[tag] = code;
    return true;
  }

  getVarType(variableName: string): string {
    return this.variableTypes_.get(variableName) || 'any';
  }

  setVarType(variableName: string, type: string): void {
    this.variableTypes_.set(variableName, type || 'any');
  }

  /** Resolve an input or field without guessing its Blockly input kind. */
  getValue(
    block: Blockly.Block,
    name: string,
    source: PythonValueSource | string = '',
  ): string {
    switch (source) {
      case 'input_statement':
        return this.unindentOnce(this.statementToCode(block, name));
      case 'input_value':
        return this.valueToCode(block, name, Order.NONE);
      case 'field_variable':
        return this.getVariableName(block.getFieldValue(name));
      default:
        return String(block.getFieldValue(name) ?? '');
    }
  }

  /** True when an assignment is emitted at module scope rather than in a procedure. */
  varIsGlobal(block: Blockly.Block): boolean {
    let current: Blockly.Block | null = block;
    while (current) {
      if (PROCEDURE_DEFINITION_BLOCKS.has(current.type)) return false;
      current = current.getParent();
    }
    return true;
  }

  private addSectionCode(
    section: PythonCodeSection,
    tag: string,
    code: string,
    overwrite: boolean,
  ): boolean {
    this.assertTag(tag);
    const target = this.sections_[section];
    if (target.has(tag) && !overwrite) return false;
    target.set(tag, code);
    return true;
  }

  private assertTag(tag: string): void {
    if (!tag || !tag.trim()) {
      throw new Error('Python generator section tags must not be empty.');
    }
  }

  private sectionValues(section: PythonCodeSection): string[] {
    return [...this.sections_[section].values()]
      .map(normalizeSnippet)
      .filter((snippet) => Boolean(snippet.trim()));
  }

  private buildExecutable(code: string): string {
    const oneShot = joinSnippets([
      ...this.sectionValues('setups_begin'),
      ...this.sectionValues('setups'),
      ...this.sectionValues('setups_end'),
      code,
    ]);
    const loopBody = joinSnippets([
      ...this.sectionValues('loops_begin'),
      ...this.sectionValues('loops'),
      ...this.sectionValues('loops_end'),
    ]);
    const cleanups = this.sectionValues('cleanups').reverse();

    const core = joinSnippets([
      oneShot,
      loopBody
        ? `while True:\n${this.indentBlock(this.ensureSuite(loopBody))}`
        : '',
    ]);
    const cleanupSuite = cleanups
      .map(
        (cleanup) =>
          `try:\n${this.indentBlock(this.ensureSuite(cleanup))}\n` +
          `except Exception:\n${this.INDENT}pass`,
      )
      .join('\n');

    if (loopBody && this.catchKeyboardInterrupt_ && cleanupSuite) {
      return (
        `try:\n${this.indentBlock(this.ensureSuite(core))}\n` +
        `except KeyboardInterrupt:\n${this.INDENT}pass\n` +
        `finally:\n${this.indentBlock(cleanupSuite)}`
      );
    }
    if (loopBody && this.catchKeyboardInterrupt_) {
      return (
        `try:\n${this.indentBlock(this.ensureSuite(core))}\n` +
        `except KeyboardInterrupt:\n${this.INDENT}pass`
      );
    }
    if (cleanupSuite) {
      return (
        `try:\n${this.indentBlock(this.ensureSuite(core))}\n` +
        `finally:\n${this.indentBlock(cleanupSuite)}`
      );
    }
    return core;
  }

  private indentBlock(code: string): string {
    return normalizeSnippet(code)
      .split('\n')
      .map((line) => (line ? this.INDENT + line : ''))
      .join('\n');
  }

  private ensureSuite(code: string): string {
    const normalized = normalizeSnippet(code);
    const hasStatement = normalized.split('\n').some((line) => {
      const trimmed = line.trim();
      return Boolean(trimmed && !trimmed.startsWith('#'));
    });
    return hasStatement ? normalized : joinSnippets([normalized, 'pass']);
  }

  private parenthesizeForOrder(
    code: string,
    outerOrder: Order,
    innerOrder: Order,
  ): string {
    const outerClass = Math.floor(outerOrder);
    const innerClass = Math.floor(innerOrder);
    if (outerClass > innerClass) return code;
    if (
      outerClass === innerClass &&
      (outerClass === Order.ATOMIC || outerClass === Order.NONE)
    ) {
      return code;
    }
    const isOverride = this.ORDER_OVERRIDES.some(
      ([outer, inner]) => outer === outerOrder && inner === innerOrder,
    );
    return isOverride ? code : `(${code})`;
  }

  private unindentOnce(code: string): string {
    return code
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => (line.startsWith(this.INDENT) ? line.slice(this.INDENT.length) : line))
      .join('\n');
  }
}

const STANDARD_BLOCK_GENERATORS = Object.freeze({
  ...blocklyPythonGenerator.forBlock,
});

/**
 * Install Blockly's canonical CPython handlers on an independent generator.
 * The handlers receive this project's generator instance at invocation time;
 * no state is shared with Blockly's singleton.
 */
export function installStandardPythonGenerators(
  generator: PythonGenerator,
): PythonGenerator {
  for (const [blockType, blockGenerator] of Object.entries(
    STANDARD_BLOCK_GENERATORS,
  )) {
    generator.forBlock[blockType] = blockGenerator as unknown as typeof generator.forBlock[string];
  }
  return generator;
}

/** Create an isolated, fully populated CPython generator. */
export function createPythonGenerator(
  options: PythonGeneratorOptions = {},
): PythonGenerator {
  return installStandardPythonGenerators(new PythonGenerator(options));
}
