import type { WritableSignal } from '@angular/core'
import type { GraphEditorState } from './types'

/**
 * Graph Editor 页面信号集合。
 */
export interface GraphEditorSignals {
	/** 页面加载状态。 */
	loading: WritableSignal<boolean>
	/** 页面级错误信息。 */
	error: WritableSignal<string | null>
	/** 当前 graph JSON 文本。 */
	graphJson: WritableSignal<string>
	/** graph JSON 是否已改动。 */
	graphJsonDirty: WritableSignal<boolean>
	/** graph JSON 解析错误。 */
	graphJsonError: WritableSignal<string | null>
	/** 当前 AWS 文本。 */
	awsContent: WritableSignal<string>
	/** AWS 文本是否已改动。 */
	awsDirty: WritableSignal<boolean>
	/** 云同步认证 token。 */
	cloudAuthToken: WritableSignal<string>
	/** 当前 graph 提取出的 pinmap hints。 */
	pinmapHints: WritableSignal<Array<string>>
	/** 当前编辑中的 pinmapId。 */
	pinmapId: WritableSignal<string>
	/** 当前 pinmap JSON。 */
	pinmapJson: WritableSignal<string>
	/** 当前 pinmap JSON 解析错误。 */
	pinmapJsonError: WritableSignal<string | null>
	/** 保存 pinmap 时的忙碌状态。 */
	pinmapSaveBusy: WritableSignal<boolean>
	/** 当前 pinmap template 协议。 */
	pinmapTemplateProtocol: WritableSignal<string>
	/** 当前 pinmap template JSON。 */
	pinmapTemplateJson: WritableSignal<string>
	/** 云 pinmap 同步忙碌状态。 */
	syncBusy: WritableSignal<boolean>
	/** 页面状态提示。 */
	saveMessage: WritableSignal<string | null>
	/** 聚合后的 graph editor 页面状态。 */
	state: WritableSignal<GraphEditorState>
}
