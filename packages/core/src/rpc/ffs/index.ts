import { r } from '../trpc'
import { default as buildPartitionFileName } from './buildPartitionFileName'
import { default as getDefaultUploadPath } from './getDefaultUploadPath'
import { default as isPlausiblePartitionEntry } from './isPlausiblePartitionEntry'
import { default as parsePartitionTable } from './parsePartitionTable'
import { default as validateUploadFileName } from './validateUploadFileName'

export default r({
	parsePartitionTable,
	isPlausiblePartitionEntry,
	buildPartitionFileName,
	getDefaultUploadPath,
	validateUploadFileName
})
