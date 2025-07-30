// const SERVER_URL: string = "http://localhost:8000";
const SERVER_URL: string = '';
const SERVER_API_URL: string = 'http://114.132.150.141:8000';

export const API = {
  projectList: `${SERVER_URL}/-/verdaccio/data/packages`,
  projectSearch: `${SERVER_URL}/-/v1/search`,
  // ai
  startSession: `${SERVER_API_URL}/api/v1/start_session`,
  closeSession: `${SERVER_API_URL}/api/v1/close_session`,
  streamConnect: `${SERVER_API_URL}/api/v1/stream`,
  sendMessage: `${SERVER_API_URL}/api/v1/send_message`,
  getHistory: `${SERVER_API_URL}/api/v1/conversation_history`,
};
