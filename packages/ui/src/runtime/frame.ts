import { DomSanitizer } from '@angular/platform-browser'

/**
 * 规范化 iframe 目标 URL。
 * @param sanitizer - Angular 资源 URL 处理器
 * @param rawUrl - 原始输入 URL
 * @param fallbackUrl - 兜底使用的 URL
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
