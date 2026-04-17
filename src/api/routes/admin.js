import express from 'express';
import { verifyToken } from '../auth.js';
import { AuthService } from '../../services/index.js';

const router = express.Router();
const authService = new AuthService();
await authService.init();

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '未授权' } });
  }
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '无效的令牌' } });
  }
  if (decoded.role !== 'admin') {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '需要管理员权限' } });
  }
  req.user = decoded;
  next();
}

router.get('/users', adminMiddleware, async (req, res) => {
  try {
    const users = await authService.getAllUsers();
    const safeUsers = users.map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      parentId: u.parentId,
      theme: u.theme,
      createdAt: u.createdAt,
    }));
    res.json({ success: true, data: safeUsers });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.post('/users', adminMiddleware, async (req, res) => {
  try {
    const { username, password, role = 'user' } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少用户名或密码' } });
    }
    const user = await authService.createUser(username, password, role, req.user.id);
    res.status(201).json({
      success: true,
      data: { id: user.id, username: user.username, role: user.role, parentId: user.parentId, theme: user.theme },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.put('/users/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { theme } = req.body;
    if (theme) {
      const user = await authService.updateUserTheme(id, theme);
      if (!user) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '用户不存在' } });
      }
      res.json({ success: true, data: { id: user.id, theme: user.theme } });
    } else {
      res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '无效的参数' } });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.put('/users/:id/password', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少新密码' } });
    }
    const bcrypt = (await import('bcryptjs')).default;
    const newHash = bcrypt.hashSync(password, 10);
    await authService.userRepo.updateUser(id, { passwordHash: newHash });
    res.json({ success: true, data: { message: '密码已重置' } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.delete('/users/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) {
      return res.status(400).json({ success: false, error: { code: 'CANNOT_DELETE_SELF', message: '不能删除自己' } });
    }
    await authService.deleteUser(id);
    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/sub-accounts', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '未授权' } });
    }
    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '无效的令牌' } });
    }

    const subAccounts = await authService.getSubAccounts(decoded.id);
    res.json({ success: true, data: subAccounts });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

export default router;
