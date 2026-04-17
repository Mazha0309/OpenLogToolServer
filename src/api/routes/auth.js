import express from 'express';
import { login, refreshToken, changePassword, updateUsername, getUserInfo, updateTheme, verifyToken } from '../auth.js';

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少用户名或密码' } });
    }
    const result = await login(username, password);
    if (!result.success) {
      return res.status(401).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少 refreshToken' } });
    }
    const result = await refreshToken(token);
    if (!result.success) {
      return res.status(401).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.put('/password', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '未授权' } });
    }
    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '无效的令牌' } });
    }

    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少旧密码或新密码' } });
    }

    const result = await changePassword(decoded.id, oldPassword, newPassword);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '未授权' } });
    }
    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '无效的令牌' } });
    }

    const result = await getUserInfo(decoded.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.put('/theme', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '未授权' } });
    }
    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '无效的令牌' } });
    }

    const { theme } = req.body;
    if (!theme || !['light', 'dark'].includes(theme)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '无效的主题值' } });
    }

    const result = await updateTheme(decoded.id, theme);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.put('/username', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '未授权' } });
    }
    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '无效的令牌' } });
    }

    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少用户名' } });
    }

    const result = await updateUsername(decoded.id, username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

export default router;
