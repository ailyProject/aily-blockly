import { r } from '../trpc'
import { default as createImageDirectory } from './createImageDirectory'
import { default as deleteImageEntry } from './deleteImageEntry'
import { default as formatImageFilesystem } from './formatImageFilesystem'
import { default as getPreviewSnapshot } from './getPreviewSnapshot'
import { default as inspectImage } from './inspectImage'
import { default as readImageFilePreview } from './readImageFilePreview'
import { default as renameImageEntry } from './renameImageEntry'
import { default as resolveBaud } from './resolveBaud'
import { default as writeImageFile } from './writeImageFile'

export default r({
	createImageDirectory,
	deleteImageEntry,
	formatImageFilesystem,
	getPreviewSnapshot,
	inspectImage,
	readImageFilePreview,
	renameImageEntry,
	resolveBaud,
	writeImageFile
})
