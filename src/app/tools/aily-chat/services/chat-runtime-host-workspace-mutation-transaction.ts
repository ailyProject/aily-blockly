import type {
  ChatRuntimeHostSessionId,
  ChatRuntimeHostWorkspaceMutationBatch,
  ChatRuntimeHostWorkspaceMutationReceipt,
  ChatRuntimeHostWorkspaceMutationReceiptInput,
} from '../core/chat-runtime-host-contract';

export interface WorkspaceMutationRollbackFileSystem {
  exists(filePath: string): Promise<boolean> | boolean;
  readFile(filePath: string): Promise<string> | string;
  readFileBytes?(filePath: string): Promise<Uint8Array> | Uint8Array;
  writeFile(filePath: string, content: string): Promise<void> | void;
  writeFileBytes?(filePath: string, content: Uint8Array): Promise<void> | void;
  deleteFile(filePath: string): Promise<void> | void;
}

interface CapturedTextFile {
  readonly filePath: string;
  readonly existedBefore: boolean;
  readonly beforeContent: string | null;
  recorded: boolean;
}

export class ChatRuntimeHostWorkspaceMutationTransaction {
  private readonly receipts: ChatRuntimeHostWorkspaceMutationReceipt[] = [];
  private readonly capturedTextFiles: CapturedTextFile[] = [];
  private readonly capturedTextFilePaths = new Set<string>();

  constructor(
    private readonly identity: {
      readonly sessionId: ChatRuntimeHostSessionId;
      readonly turnId: string;
      readonly toolCallId: string;
      readonly transactionId: string;
    },
    private readonly fileSystem: WorkspaceMutationRollbackFileSystem,
  ) {}

  readonly record = (input: ChatRuntimeHostWorkspaceMutationReceiptInput): void => {
    const sequence = this.receipts.length;
    const operationKind = input.operationKind ?? (!input.existedBefore
      ? 'create'
      : input.afterContent === null && input.afterBytes == null
        ? 'delete'
        : input.contentKind === 'notebook'
          ? 'notebook-edit'
          : 'replace');
    this.receipts.push({
      ...this.identity,
      operationId: `${this.identity.transactionId}:${sequence}`,
      sequence,
      operationKind,
      ...input,
    });
  };

  async captureTextFiles(filePaths: readonly string[]): Promise<void> {
    for (const filePath of filePaths) {
      if (this.capturedTextFilePaths.has(filePath)) {
        continue;
      }
      const existedBefore = await Promise.resolve(this.fileSystem.exists(filePath));
      const beforeContent = existedBefore
        ? await Promise.resolve(this.fileSystem.readFile(filePath))
        : null;
      this.capturedTextFiles.push({
        filePath,
        existedBefore,
        beforeContent,
        recorded: false,
      });
      this.capturedTextFilePaths.add(filePath);
    }
  }

  async recordCapturedTextFileChanges(): Promise<void> {
    for (const captured of this.capturedTextFiles) {
      if (captured.recorded) {
        continue;
      }
      const existsAfter = await Promise.resolve(this.fileSystem.exists(captured.filePath));
      const afterContent = existsAfter
        ? await Promise.resolve(this.fileSystem.readFile(captured.filePath))
        : null;
      captured.recorded = true;
      if (captured.existedBefore === existsAfter && captured.beforeContent === afterContent) {
        continue;
      }
      this.record({
        filePath: captured.filePath,
        existedBefore: captured.existedBefore,
        contentKind: 'text',
        beforeContent: captured.beforeContent,
        afterContent,
      });
    }
  }

  get hasMutations(): boolean {
    return this.receipts.length > 0;
  }

  createBatch(
    status: ChatRuntimeHostWorkspaceMutationBatch['status'] = 'committed',
  ): ChatRuntimeHostWorkspaceMutationBatch {
    return {
      ...this.identity,
      status,
      receipts: this.receipts.map(receipt => ({ ...receipt })),
    };
  }

  async rollback(): Promise<void> {
    for (const receipt of [...this.receipts].reverse()) {
      if (this.capturedTextFilePaths.has(receipt.filePath)) {
        continue;
      }
      if (receipt.operationKind === 'rename') {
        const fromPath = receipt.fromPath;
        const toPath = receipt.toPath;
        if (!fromPath || !toPath) {
          throw new Error('Cannot roll back rename without canonical from/to paths.');
        }
        if (await Promise.resolve(this.fileSystem.exists(toPath))) {
          await Promise.resolve(this.fileSystem.deleteFile(toPath));
        }
        await this.restoreBeforeImage(receipt, fromPath);
        continue;
      }
      if (!receipt.existedBefore) {
        if (await Promise.resolve(this.fileSystem.exists(receipt.filePath))) {
          await Promise.resolve(this.fileSystem.deleteFile(receipt.filePath));
        }
      } else {
        await this.restoreBeforeImage(receipt, receipt.filePath);
      }
    }
    for (const captured of [...this.capturedTextFiles].reverse()) {
      if (captured.existedBefore) {
        await Promise.resolve(this.fileSystem.writeFile(captured.filePath, captured.beforeContent ?? ''));
      } else if (await Promise.resolve(this.fileSystem.exists(captured.filePath))) {
        await Promise.resolve(this.fileSystem.deleteFile(captured.filePath));
      }
    }
  }

  private async restoreBeforeImage(
    receipt: ChatRuntimeHostWorkspaceMutationReceipt,
    filePath: string,
  ): Promise<void> {
    if (receipt.contentKind === 'text' || receipt.contentKind === 'notebook') {
      await Promise.resolve(this.fileSystem.writeFile(filePath, receipt.beforeContent ?? ''));
      return;
    }
    if (receipt.contentKind === 'binary' && this.fileSystem.writeFileBytes && receipt.beforeBytes) {
      await Promise.resolve(this.fileSystem.writeFileBytes(filePath, receipt.beforeBytes));
      return;
    }
    throw new Error(`Unsupported workspace mutation rollback content kind: ${receipt.contentKind}`);
  }
}
