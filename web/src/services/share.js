import api from '../utils/api';

export async function getShares() {
  return api.get('/shares');
}

export async function createShare(data) {
  return api.post('/shares', data);
}

export async function updateShare(id, data) {
  return api.put(`/shares/${id}`, data);
}

export async function deleteShare(id) {
  return api.delete(`/shares/${id}`);
}

export async function getSharedLogs() {
  return api.get('/shares/shared-logs');
}

export async function getSharedDictionaries() {
  return api.get('/shares/shared-dictionaries');
}