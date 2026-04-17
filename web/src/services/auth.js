import api from '../utils/api';

export async function login(username, password) {
  return api.post('/auth/login', { username, password });
}

export async function register(username, password) {
  return api.post('/auth/register', { username, password, role: 'user' });
}

export async function refreshToken(refreshToken) {
  return api.post('/auth/refresh', { refreshToken });
}

export async function changePassword(oldPassword, newPassword) {
  return api.put('/auth/password', { oldPassword, newPassword });
}

export async function getMe() {
  return api.get('/auth/me');
}

export async function setTheme(theme) {
  return api.put('/auth/theme', { theme });
}

export function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('user');
}

export async function getUsers() {
  return api.get('/admin/users');
}

export async function createSubAccount(username, password) {
  return api.post('/admin/users', { username, password });
}

export async function deleteUser(id) {
  return api.delete(`/admin/users/${id}`);
}
