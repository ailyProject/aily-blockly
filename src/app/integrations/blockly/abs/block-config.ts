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
  extraState?: {
    itemCount?: number;
    elseIfCount?: number;
    hasElse?: boolean;
    params?: Array<{ type: string; name: string }>;
    returnType?: string;
    extraCount?: number;
    [key: string]: unknown;
  };
}
