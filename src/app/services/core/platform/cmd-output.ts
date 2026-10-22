export interface CmdPhysicalTerminal {
  kind: 'close' | 'exit-and-stdio-closed';
  code: number | null;
  signal: string | null;
  closeObserved: boolean;
}

export interface CmdOutput {
  type: 'stdout' | 'stderr' | 'close' | 'terminal' | 'error';
  data?: string;
  code?: number | null;
  signal?: string | null;
  error?: string;
  streamId: string;
  expected?: boolean;
  terminal?: CmdPhysicalTerminal;
  /** Bounded output collected when this command reaches its physical terminal. */
  stderr?: string;
  stdout?: string;
}

/** Physical command completion only; never a domain or process-tree ACK. */
export function isCmdTerminalOutput(output: Pick<CmdOutput, 'type' | 'code' | 'signal' | 'terminal'>): boolean {
  if (output.type === 'close') return true;
  const terminal = output.terminal;
  return output.type === 'terminal' && terminal?.kind === 'exit-and-stdio-closed'
    && terminal.closeObserved === false && terminal.code === output.code && terminal.signal === output.signal
    && (terminal.code === null || Number.isInteger(terminal.code))
    && (terminal.signal === null || typeof terminal.signal === 'string');
}
