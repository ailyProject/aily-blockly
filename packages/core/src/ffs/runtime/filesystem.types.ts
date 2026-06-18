/**
 * 底层文件系统客户端返回的原始条目。
 */
export interface FfsRuntimeRawEntry {
	/** 条目路径。 */
	path?: string
	/** 条目名称。 */
	name?: string
	/** 条目类型。 */
	type?: 'file' | 'dir' | string
	/** 条目大小。 */
	size?: number
}

/**
 * 底层客户端返回的容量快照。
 */
export interface FfsRuntimeUsageSnapshot {
	/** 总容量字节数。 */
	capacityBytes?: number
	/** 已使用字节数。 */
	usedBytes?: number
	/** 剩余字节数。 */
	freeBytes?: number
}

/**
 * SPIFFS 风格客户端。
 */
export interface FfsSpiffsClient {
	list(): Promise<Array<FfsRuntimeRawEntry>>
	read(path: string): Promise<Uint8Array>
	write(path: string, data: Uint8Array): Promise<void>
	remove(path: string): Promise<void>
	format(): Promise<void>
	toImage(): Promise<Uint8Array>
	getUsage?: () => Promise<FfsRuntimeUsageSnapshot | null>
}

/**
 * LittleFS / FATFS 风格客户端。
 */
export interface FfsTreeFilesystemClient {
	list(path: string): Array<FfsRuntimeRawEntry>
	readFile(path: string): Promise<Uint8Array> | Uint8Array
	writeFile(path: string, data: Uint8Array): Promise<void> | void
	delete?(path: string, options?: { recursive?: boolean }): Promise<void> | void
	deleteFile?(path: string): Promise<void> | void
	rename(fromPath: string, toPath: string): Promise<void> | void
	mkdir(path: string): Promise<void> | void
	format(): Promise<void>
	toImage(): Promise<Uint8Array>
	getUsage?: () => Promise<FfsRuntimeUsageSnapshot | null>
}

/**
 * FFS 底层客户端联合类型。
 */
export type FfsRuntimeClient = FfsSpiffsClient | FfsTreeFilesystemClient
