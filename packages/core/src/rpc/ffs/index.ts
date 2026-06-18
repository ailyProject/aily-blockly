import { r } from '../trpc'
import { default as buildMountPlan } from './buildMountPlan'
import { default as buildPartitionFileName } from './buildPartitionFileName'
import { default as getDefaultUploadPath } from './getDefaultUploadPath'
import { default as isPlausiblePartitionEntry } from './isPlausiblePartitionEntry'
import { default as parsePartitionTable } from './parsePartitionTable'
import { default as resolveBaud } from './resolveBaud'
import { default as summarizePartitions } from './summarizePartitions'
import { default as validateUploadFileName } from './validateUploadFileName'

export default r({
	parsePartitionTable,
	isPlausiblePartitionEntry,
	buildPartitionFileName,
	buildMountPlan,
	getDefaultUploadPath,
	resolveBaud,
	summarizePartitions,
	validateUploadFileName
})
