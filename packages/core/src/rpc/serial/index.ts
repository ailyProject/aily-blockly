import { r } from '../trpc'
import { default as connect } from './connect'
import { default as disconnect } from './disconnect'
import { default as drain } from './drain'
import { default as send } from './send'
import { default as signal } from './signal'
import { default as status } from './status'

export default r({
	connect,
	disconnect,
	drain,
	send,
	signal,
	status
})
