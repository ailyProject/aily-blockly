const CLOUD_PROJECT_COVER_WIDTH = 500
const CLOUD_PROJECT_COVER_HEIGHT = 250
const CLOUD_PROJECT_COVER_MAX_SIZE = 5 * 1024 * 1024

const readImageDataUrl = (file: File) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => {
			if (typeof reader.result === 'string') {
				resolve(reader.result)
				return
			}
			reject(new Error('Unable to read image file.'))
		}
		reader.onerror = () => reject(new Error('Unable to read image file.'))
		reader.readAsDataURL(file)
	})

const loadImageElement = (src: string) =>
	new Promise<HTMLImageElement>((resolve, reject) => {
		const image = new Image()
		image.onload = () => resolve(image)
		image.onerror = () => reject(new Error('Unable to load image preview.'))
		image.src = src
	})

/**
 * 校验云项目封面图片文件。
 * @param file - 用户选择的图片文件
 */
export const validateCloudProjectCoverFile = (file: File) => {
	if (!file.type.startsWith('image/')) {
		throw new Error('Please choose an image file.')
	}
	if (file.size > CLOUD_PROJECT_COVER_MAX_SIZE) {
		throw new Error('Image file size must be smaller than 5MB.')
	}
}

/**
 * 把封面图转换为 500x250 的 WebP 文件。
 * @param file - 原始图片文件
 */
export const processCloudProjectCoverFile = async (file: File) => {
	validateCloudProjectCoverFile(file)
	const src = await readImageDataUrl(file)
	const image = await loadImageElement(src)
	const canvas = document.createElement('canvas')
	canvas.width = CLOUD_PROJECT_COVER_WIDTH
	canvas.height = CLOUD_PROJECT_COVER_HEIGHT
	const context = canvas.getContext('2d')
	if (!context) {
		throw new Error('Unable to prepare image canvas.')
	}

	const scale = Math.max(canvas.width / image.width, canvas.height / image.height)
	const drawWidth = image.width * scale
	const drawHeight = image.height * scale
	const offsetX = (canvas.width - drawWidth) / 2
	const offsetY = (canvas.height - drawHeight) / 2

	context.clearRect(0, 0, canvas.width, canvas.height)
	context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight)

	const blob = await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob(
			nextBlob => {
				if (nextBlob) {
					resolve(nextBlob)
					return
				}
				reject(new Error('Unable to export image as WebP.'))
			},
			'image/webp',
			0.85
		)
	})

	return {
		file: new File([blob], 'cloud-project-cover.webp', { type: 'image/webp' }),
		previewUrl: URL.createObjectURL(blob)
	}
}

/**
 * 把浏览器文件转换成 Base64 文本。
 * @param file - 目标文件
 */
export const encodeCloudProjectCoverFile = (file: File) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => {
			if (typeof reader.result !== 'string') {
				reject(new Error('Unable to encode image file.'))
				return
			}
			resolve(reader.result.replace(/^data:.*?;base64,/, ''))
		}
		reader.onerror = () => reject(new Error('Unable to encode image file.'))
		reader.readAsDataURL(file)
	})
