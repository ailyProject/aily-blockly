import { DomSanitizer } from '@angular/platform-browser'

/**
 * 规范化 iframe 目标 URL。
 * @param {DomSanitizer} sanitizer - Angular 资源 URL 处理器
 * @param {string | null | undefined} rawUrl - 原始输入 URL
 * @param {string} fallbackUrl - 兜底使用的 URL
 * @returns {{url: string, origin: string, frameUrl: import('@angular/platform-browser').SafeResourceUrl}}
 */
export const buildFrameTarget = (sanitizer: DomSanitizer, rawUrl: string | null | undefined, fallbackUrl: string) => {
	const url = rawUrl?.trim() || fallbackUrl

	try {
		const target = new URL(url)
		return {
			url: target.toString(),
			origin: target.origin,
			frameUrl: sanitizer.bypassSecurityTrustResourceUrl(target.toString())
		}
	} catch {
		return {
			url: fallbackUrl,
			origin: new URL(fallbackUrl).origin,
			frameUrl: sanitizer.bypassSecurityTrustResourceUrl(fallbackUrl)
		}
	}
}
