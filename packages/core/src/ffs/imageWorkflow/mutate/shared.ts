import { exportMountedFfsImage, mountFfsFilesystem } from '../../runtime'
import { createFfsImageSnapshot, exportFfsImageBytes } from '../shared'

import type { FfsPartitionInfo } from '../../types'

/**
 * 执行一次镜像挂载后的变更动作，并导出新的镜像与快照。
 * @param input - 分区、镜像与变更动作
 */
export const runFfsImageMutation = async (input: {
	partition: FfsPartitionInfo
	image: Uint8Array
	mutate: (filesystem: Awaited<ReturnType<typeof mountFfsFilesystem>>) => Promise<void>
}) => {
	const filesystem = await mountFfsFilesystem({
		partition: input.partition,
		image: input.image
	})
	await input.mutate(filesystem)
	const image = await exportMountedFfsImage(filesystem)

	return {
		image: exportFfsImageBytes(image),
		snapshot: createFfsImageSnapshot({ partition: input.partition, filesystem })
	}
}
