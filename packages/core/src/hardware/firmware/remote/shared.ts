import { AILY_API_SERVER, DEFAULT_REGION_KEY } from 'shared'

import { getCurrentApiServer } from '../../../project'

import type { HardwareFirmwareRequest, HardwareModelFileRequest } from '../types'

export const normalizeHardwareFirmwareUrlProtocol = (url: string) => url.replace(/^http:/, 'https:')

export const resolveHardwareApiBase = (
	config?: HardwareFirmwareRequest['config'] | HardwareModelFileRequest['config']
) => (getCurrentApiServer(config?.regions, config?.region, DEFAULT_REGION_KEY) || AILY_API_SERVER).replace(/\/$/, '')
