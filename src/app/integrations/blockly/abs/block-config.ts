export interface BlockConfig {
  type: string;
  id?: string;
  fields?: Record<string, unknown>;
  inputs?: Record<string, {
    block?: BlockConfig;
    shadow?: BlockConfig;
    connection?: 'value' | 'statement';
  }>;
  position?: { x: number; y: number };
  next?: { block: BlockConfig };
  extraState?: unknown;
}
