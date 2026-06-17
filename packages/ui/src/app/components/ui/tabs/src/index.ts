import { HlmTabs } from './lib/hlm-tabs'
import { HlmTabsContent } from './lib/hlm-tabs-content'
import { HlmTabsContentLazy } from './lib/hlm-tabs-content-lazy'
import { HlmTabsList } from './lib/hlm-tabs-list'
import { HlmTabsPaginatedList } from './lib/hlm-tabs-paginated-list'
import { HlmTabsTrigger } from './lib/hlm-tabs-trigger'

export * from './lib/hlm-tabs'
export * from './lib/hlm-tabs-content'
export * from './lib/hlm-tabs-content-lazy'
export * from './lib/hlm-tabs-list'
export * from './lib/hlm-tabs-paginated-list'
export * from './lib/hlm-tabs-trigger'

export const HlmTabsImports = [
	HlmTabs,
	HlmTabsList,
	HlmTabsTrigger,
	HlmTabsContent,
	HlmTabsContentLazy,
	HlmTabsPaginatedList
] as const
