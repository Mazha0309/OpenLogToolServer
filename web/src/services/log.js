import api from '../utils/api';

export async function getLogs(params) {
  return api.get('/logs', { params });
}

export async function getLog(id) {
  return api.get(`/logs/${id}`);
}

export async function createLog(data) {
  return api.post('/logs', data);
}

export async function updateLog(id, data) {
  return api.put(`/logs/${id}`, data);
}

export async function deleteLog(id) {
  return api.delete(`/logs/${id}`);
}

export async function pushSync(logs, deviceId) {
  return api.post('/logs/sync/push', { logs, deviceId });
}

export async function pullSync(deviceId, since) {
  return api.get('/logs/sync/pull', { params: { deviceId, since } });
}

export async function bidirectionalSync(logs, deviceId) {
  return api.post('/logs/sync/bidirectional', { logs, deviceId });
}
