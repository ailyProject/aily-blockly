import { v4 as uuidv4 } from 'uuid'

export const createMessageId = () => `msg_${uuidv4()}`
export const createSessionId = () => `session_${uuidv4()}`
