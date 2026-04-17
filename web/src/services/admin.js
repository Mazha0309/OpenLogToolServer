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
