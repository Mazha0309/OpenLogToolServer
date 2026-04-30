import api from '../utils/api';

export async function getSessions() {
  return api.get('/logs/sessions');
}

export async function getSessionLogs(sessionId, params) {
  return api.get(`/logs/sessions/${sessionId}/logs`, { params });
}
