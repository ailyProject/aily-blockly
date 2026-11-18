import type * as Blockly from 'blockly';

export interface ArduinoModelSymbolOptions {
  role?: string;
  scope?: string;
  /** Explicitly distinguish a legacy text declaration from a native ID. */
  by?: 'name' | 'id';
}

export interface ArduinoModelSymbolDeclaration extends ArduinoModelSymbolOptions {
  nameOrId: string;
  type: string;
}

export type ArduinoModelSymbolDeclarations =
  (workspace: Blockly.Workspace) => Iterable<ArduinoModelSymbolDeclaration>;

export interface ArduinoModelReference {
  getId(): string;
}

export interface ArduinoModelIdentity extends ArduinoModelReference {
  getName(): string;
  getType(): string;
}

export type ArduinoModelSymbolLocalScope = (block: Blockly.Block, model: ArduinoModelIdentity) => boolean;

/** Opt-in code names; native IDs, visible names and public Blockly naming stay intact. */
export class ArduinoModelSymbols {
  private readonly declarations = new Map<string, ArduinoModelSymbolDeclarations>();
  private readonly localScopes = new Map<string, ArduinoModelSymbolLocalScope>();
  private readonly claims = new Set<string>();
  private readonly names = new Map<string, string>();
  private readonly adaptedNames = new WeakSet<Blockly.Names>();
  private workspace?: Blockly.Workspace;
  private nameDB?: Blockly.Names;

  constructor(private readonly isLocalReference?: (model: ArduinoModelIdentity) => boolean) {}

  registerDeclarations(key: string, resolve: ArduinoModelSymbolDeclarations): void {
    if (!key || typeof resolve !== 'function') throw new Error('Invalid model symbol declaration registration.');
    this.declarations.set(key, resolve);
  }

  registerLocalScope(key: string, resolve: ArduinoModelSymbolLocalScope): void {
    if (!key || typeof resolve !== 'function') throw new Error('Invalid model symbol local scope registration.');
    this.localScopes.set(key, resolve);
  }

  hasLocalScope(block: Blockly.Block, model: ArduinoModelIdentity): boolean {
    return [...this.localScopes.values()].some(resolve => resolve(block, model) === true);
  }

  reset(): void {
    this.workspace = undefined;
    this.nameDB = undefined;
    this.claims.clear();
    this.names.clear();
  }

  begin(workspace: Blockly.Workspace, nameDB: Blockly.Names): void {
    this.reset();
    this.workspace = workspace;
    this.nameDB = nameDB;
    if (!this.adaptedNames.has(nameDB)) {
      const original = nameDB.getName, symbols = this;
      nameDB.getName = function(nameOrId, type) {
        // Correct legacy generators already pass native IDs to Blockly Names.
        // Only owned variable IDs join this code domain; procedure/text names
        // and unrelated models retain their original instance behavior.
        return (type === 'VARIABLE' ? symbols.reference(nameOrId) : undefined)
          ?? original.call(this, nameOrId, type);
      };
      this.adaptedNames.add(nameDB);
    }
    try {
      for (const resolve of this.declarations.values()) {
        for (const declaration of resolve(workspace)) {
          this.symbol(declaration.nameOrId, declaration.type, declaration);
        }
      }
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  symbol(nameOrId: string, type: string, options: ArduinoModelSymbolOptions = {}): string {
    const variables = this.currentWorkspace().getVariableMap();
    if (options.by !== undefined && options.by !== 'name' && options.by !== 'id') {
      throw new Error('Model symbol identity must use a name or native ID.');
    }
    const byId = options.by === 'name' ? null : variables.getVariableById(nameOrId);
    const byName = options.by === 'id' ? null : variables.getVariable(nameOrId, type);
    if (!options.by && byId && byName && byId.getId() !== byName.getId()) {
      throw new Error('Ambiguous model identity; specify a name or native ID.');
    }
    const model = byId ?? byName;
    if (!model || model.getType() !== type) throw new Error('Code symbol requires an existing model of the requested type.');
    const key = this.modelKey(model.getId(), type, options);
    this.claims.add(key);
    return this.allocate(key);
  }

  reference(modelOrId: ArduinoModelReference | string, options: ArduinoModelSymbolOptions = {}): string | undefined {
    if (!this.workspace) return undefined;
    // Text labels are intentionally not guessed here: an unresolved procedure
    // parameter must not adopt a same-named global model's generated symbol.
    const id = typeof modelOrId === 'string' ? modelOrId : modelOrId.getId();
    const model = this.workspace.getVariableMap().getVariableById(id);
    if (!model) return undefined;
    const key = this.modelKey(model.getId(), model.getType(), options);
    if (!this.claims.has(key)) return undefined;
    if (this.isLocalReference?.(model)) return undefined;
    return this.allocate(key);
  }

  private currentWorkspace(): Blockly.Workspace {
    if (!this.workspace || !this.nameDB) throw new Error('Model symbols require an initialized generation.');
    return this.workspace;
  }

  private modelKey(id: string, type: string, options: ArduinoModelSymbolOptions): string {
    const role = options.role ?? 'value', scope = options.scope ?? 'global';
    if (typeof role !== 'string' || !role || typeof scope !== 'string' || !scope) {
      throw new Error('Model symbol role and scope must be nonempty strings.');
    }
    return JSON.stringify([id, type, role, scope]);
  }

  private allocate(key: string): string {
    const cached = this.names.get(key);
    if (cached) return cached;
    // Encode the complete identity rather than a display-name spelling or hash.
    // The generated prefix avoids bare SDK globals; it is a naming domain,
    // weaker than a separate C++ namespace but valid in legacy global slots.
    const encoded = Array.from(key, character => character.codePointAt(0)!.toString(36)).join('_');
    const name = this.nameDB!.getDistinctName('ailyModel_' + encoded, 'DEVELOPER_VARIABLE');
    this.names.set(key, name);
    return name;
  }
}
