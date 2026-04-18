import api from '../utils/api';

export async function getStats() {
  return api.get('/admin/stats');
}

export async function getDevices() {
  return api.get('/admin/devices');
}

export async function getSyncLogs(limit) {
  return api.get('/admin/sync-logs', { params: { limit } });
}

export async function getServerInfo() {
  return api.get('/admin/server-info');
}

export async function getUsers() {
  return api.get('/admin/users');
}

export async function createUser(data) {
  return api.post('/admin/users', data);
}

export async function deleteUser(id) {
  return api.delete(`/admin/users/${id}`);
}
