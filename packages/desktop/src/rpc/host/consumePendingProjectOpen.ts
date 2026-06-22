import { consumeDesktopPendingProjectOpenPath } from '../../project-open'
import { p } from '../../trpc'

import type { DesktopPendingProjectOpenResult } from '../types'

/**
 * 读取并消费桌面宿主待打开项目路径。
 */
export default p.query(
	async (): Promise<DesktopPendingProjectOpenResult> => ({
		available: true,
		path: consumeDesktopPendingProjectOpenPath()
	})
)
