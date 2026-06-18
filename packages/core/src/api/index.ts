import { Hono } from 'hono'

import * as session from './session'

const api = new Hono().get('/session', session.get).post('/session', session.post)

export default api
export * from './types'
