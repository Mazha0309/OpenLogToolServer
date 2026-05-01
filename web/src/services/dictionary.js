import api from '../utils/api';

export async function getDictionaries(params = {}) {
  return api.get('/dictionaries', { params });
}

export async function createDictionary(type, data) {
  return api.post('/dictionaries', { type, ...data });
}

export async function updateDictionary(id, data) {
  return api.put(`/dictionaries/${id}`, data);
}

export async function deleteDictionary(id) {
  return api.delete(`/dictionaries/${id}`);
}

export async function bulkCreateDictionary(type, items) {
  return api.post('/dictionaries/bulk', { type, items });
}
