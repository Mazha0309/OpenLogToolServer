import api from '../utils/api';

export async function getSessions() {
  return api.get('/logs/sessions');
}
