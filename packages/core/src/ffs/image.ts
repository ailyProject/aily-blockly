/**
 * 判断分区镜像是否为空白镜像（全 `0xFF`）。
 * @param image - 原始镜像字节
 */
export const isBlankFfsImage = (image: Uint8Array) => {
	if (image.length === 0) return false

	const sampleIndexes = [0, image.length - 1, image.length >> 1]
	for (const index of sampleIndexes) {
		if (image[index] !== 0xff) return false
	}

	for (let index = 0; index < image.length; index += 1) {
		if (image[index] !== 0xff) return false
	}

	return true
}
