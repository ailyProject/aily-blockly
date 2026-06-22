import { router } from '../../trpc'
import { default as close } from './close'
import { default as create } from './create'
import { default as executeOnce } from './executeOnce'
import { default as interrupt } from './interrupt'
import { default as resize } from './resize'
import { default as stream } from './stream'
import { default as write } from './write'

export default router({
	create,
	write,
	executeOnce,
	resize,
	interrupt,
	close,
	stream
})
