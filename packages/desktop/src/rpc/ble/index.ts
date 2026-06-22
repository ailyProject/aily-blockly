import { router } from '../../trpc'
import { default as deviceList } from './deviceList'
import { default as setPreferredDevice } from './setPreferredDevice'
import { default as startDeviceListUpdates } from './startDeviceListUpdates'
import { default as stopDeviceListUpdates } from './stopDeviceListUpdates'

export default router({
	deviceList,
	setPreferredDevice,
	startDeviceListUpdates,
	stopDeviceListUpdates
})
