import jwt from 'jsonwebtoken';
import { AuthService } from '../services/index.js';

const authService = new AuthService();
await authService.init();

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

export function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function generateRefreshToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export async function authenticateToken(token) {
  const decoded = verifyToken(token);
  if (!decoded) {
    return { success: false, error: { code: 'INVALID_TOKEN', message: '无效的令牌' } };
  }

  const user = await authService.getUserById(decoded.id);
  if (!user) {
    return { success: false, error: { code: 'USER_NOT_FOUND', message: '用户不存在或登录已失效' } };
  }

  return {
    success: true,
    data: {
      id: user.id,
      username: user.username,
      role: user.role,
      parentId: user.parentId,
      theme: user.theme,
    },
  };
}

export async function register(username, password, role = 'user', parentId = null) {
  const existingUser = await authService.getUserByUsername(username);
  if (existingUser) {
    return { success: false, error: { code: 'USER_EXISTS', message: '用户名已存在' } };
  }

  const allUsers = await authService.getAllUsers();
  const isFirstUser = allUsers.length === 0;
  const userRole = isFirstUser ? 'admin' : role;

  const user = await authService.createUser(username, password, userRole, parentId);
  const payload = { id: user.id, username: user.username, role: user.role, parentId: user.parentId };

  return {
    success: true,
    data: {
      token: generateToken(payload),
      refreshToken: generateRefreshToken(payload),
      user: { id: user.id, username: user.username, role: user.role, parentId: user.parentId, theme: user.theme },
    },
  };
}

export async function login(username, password) {
  const user = await authService.validateUser(username, password);
  if (!user) {
    return { success: false, error: { code: 'INVALID_CREDENTIALS', message: '用户名或密码错误' } };
  }

  const payload = { id: user.id, username: user.username, role: user.role, parentId: user.parentId };
  return {
    success: true,
    data: {
      token: generateToken(payload),
      refreshToken: generateRefreshToken(payload),
      user: { id: user.id, username: user.username, role: user.role, parentId: user.parentId, theme: user.theme },
    },
  };
}

export async function refreshToken(refreshToken) {
  const authResult = await authenticateToken(refreshToken);
  if (!authResult.success) {
    return { success: false, error: { code: authResult.error.code, message: authResult.error.message === '无效的令牌' ? '无效的刷新令牌' : authResult.error.message } };
  }

  const decoded = authResult.data;

  const payload = { id: decoded.id, username: decoded.username, role: decoded.role, parentId: decoded.parentId };
  return {
    success: true,
    data: {
      token: generateToken(payload),
      refreshToken: generateRefreshToken(payload),
    },
  };
}

export async function changePassword(userId, oldPassword, newPassword) {
  const success = await authService.changePassword(userId, oldPassword, newPassword);
  if (!success) {
    return { success: false, error: { code: 'CHANGE_PASSWORD_FAILED', message: '修改密码失败' } };
  }
  return { success: true, data: { message: '密码修改成功' } };
}

export async function updateUsername(userId, newUsername) {
  const existing = await authService.getUserByUsername(newUsername);
  if (existing && existing.id !== userId) {
    return { success: false, error: { code: 'USER_EXISTS', message: '用户名已存在' } };
  }
  const user = await authService.updateUsername(userId, newUsername);
  if (!user) {
    return { success: false, error: { code: 'UPDATE_FAILED', message: '更新用户名失败' } };
  }
  return { success: true, data: { username: user.username } };
}

export async function getUserInfo(userId) {
  const user = await authService.getUserById(userId);
  if (!user) {
    return { success: false, error: { code: 'USER_NOT_FOUND', message: '用户不存在' } };
  }
  return {
    success: true,
    data: { id: user.id, username: user.username, role: user.role, parentId: user.parentId, theme: user.theme },
  };
}

export async function updateTheme(userId, theme) {
  const user = await authService.updateUserTheme(userId, theme);
  if (!user) {
    return { success: false, error: { code: 'UPDATE_FAILED', message: '更新主题失败' } };
  }
  return { success: true, data: { theme: user.theme } };
}
