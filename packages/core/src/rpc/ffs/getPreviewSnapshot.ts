import { createFfsPreviewSnapshot, ffsPreviewPartition } from '../../ffs'
import { p } from '../trpc'

export default p.query(async () => {
	const filesystem = await createFfsPreviewSnapshot()

	return {
		partition: ffsPreviewPartition,
		type: filesystem.type,
		blockSize: filesystem.blockSize ?? null,
		fileCount: filesystem.files.length,
		files: filesystem.files,
		usage: filesystem.usage
	}
})
