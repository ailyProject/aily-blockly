/**
 * 云项目归档导入输入。
 */
export interface ProjectImportCloudArchiveInput {
	/** 云端归档下载地址；若未提供，可改用 projectId 走 core 内部下载路径。 */
	archiveUrl?: string
	/** 云项目 ID；用于直接命中 `/cloud/projects/:id/download`。 */
	projectId?: string
	/** 当通过 projectId 下载用户项目归档时使用的 Bearer token。 */
	authToken?: string
	/** 导入后的目标项目目录。 */
	targetPath: string
	/** 导入后写入 package.json 的项目主名称。 */
	name?: string
	/** 导入后写入 package.json 的昵称。 */
	nickname?: string
	/** 导入后写入 package.json 的描述。 */
	description?: string
	/** 导入后写入 package.json 的云项目 ID。 */
	cloudId?: string
	/** 导入后写入 package.json 的标签列表。 */
	tags?: Array<string>
}

/**
 * 云项目归档导入结果。
 */
export interface ProjectImportCloudArchiveResult {
	/** 最终项目目录。 */
	projectPath: string
	/** 被写回的 package.json 路径。 */
	packageJsonPath: string
	/** 实际下载的归档地址。 */
	archiveUrl: string
}
