const SERVER_URL: string = 'https://aily-chat.diandeng.tech';
const CHAT_SERVER_URL: string = 'http://114.132.150.141:8100';
const AUTH_SERVER_URL: string = 'http://114.132.150.141:8101';
const WORKSPACE_SERVER_URL: string = 'http://114.132.150.141:8102';
const REGISTRY_URL: string = 'https://registry.diandeng.tech';

export const API = {
  projectList: `${REGISTRY_URL}/-/verdaccio/data/packages`,
  projectSearch: `${REGISTRY_URL}/-/v1/search`,
  // auth
  login: `${AUTH_SERVER_URL}/api/v1/auth/login`,
  register: `${AUTH_SERVER_URL}/api/v1/auth/register`,
  logout: `${AUTH_SERVER_URL}/api/v1/auth/logout`,
  verifyToken: `${AUTH_SERVER_URL}/api/v1/auth/verify`,
  refreshToken: `${AUTH_SERVER_URL}/api/v1/auth/refresh`,
  me: `${AUTH_SERVER_URL}/api/v1/auth/me`,
  // github oauth
  githubBrowserAuthorize: `${AUTH_SERVER_URL}/api/v1/oauth/github/browser-authorize`,
  githubTokenExchange: `${AUTH_SERVER_URL}/api/v1/oauth/github/token-exchange`,
  // ai
  startSession: `${CHAT_SERVER_URL}/api/v1/start_session`,
  closeSession: `${CHAT_SERVER_URL}/api/v1/close_session`,
  streamConnect: `${CHAT_SERVER_URL}/api/v1/stream`,
  sendMessage: `${CHAT_SERVER_URL}/api/v1/send_message`,
  getHistory: `${CHAT_SERVER_URL}/api/v1/conversation_history`,
  stopSession: `${CHAT_SERVER_URL}/api/v1/stop_session`,
  cancelTask: `${CHAT_SERVER_URL}/api/v1/cancel_task`,
  // cloud
  cloudBase: `${WORKSPACE_SERVER_URL}/api/v1/cloud`,
  cloudSync: `${WORKSPACE_SERVER_URL}/api/v1/cloud/sync`,
  cloudProjects: `${WORKSPACE_SERVER_URL}/api/v1/cloud/projects`,
  cloudPublicProjects: `${WORKSPACE_SERVER_URL}/api/v1/cloud/projects/public`,
  // feedback
  feedback: `${WORKSPACE_SERVER_URL}/api/v1/feedback/submit`,
};
