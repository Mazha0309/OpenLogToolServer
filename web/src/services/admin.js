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

export async function getDbConfig() {
  return api.get('/admin/config');
}

export async function updateDbConfig(data) {
  return api.put('/admin/config', data);
}

export async function restartServer() {
  return api.post('/admin/restart');
}

export async function getAdminLogs(params) {
  return api.get('/admin/logs', { params });
}

export async function getAdminDictionaries(params) {
  return api.get('/admin/dictionaries', { params });
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

export async function resetDatabase() {
  return api.post('/admin/reset-db');
}

export async function getAllShares() {
  return api.get('/admin/shares');
}

export async function deleteShareById(id) {
  return api.delete(`/admin/shares/${id}`);
}

export async function getPublicLinks() {
  return api.get('/admin/public-links');
}

export async function deletePublicLink(id) {
  return api.delete(`/admin/public-links/${id}`);
}

export async function togglePublicLink(id, enabled) {
  return api.put(`/admin/public-links/${id}/toggle`, { enabled });
}
