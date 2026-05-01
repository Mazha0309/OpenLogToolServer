import express from 'express';
import { login, refreshToken, changePassword, updateUsername, getUserInfo, updateTheme, authenticateToken } from '../auth.js';

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
    const authResult = await authenticateToken(token);
    if (!authResult.success) {
      return res.status(401).json({ success: false, error: authResult.error });
    }

    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少旧密码或新密码' } });
    }

    const result = await changePassword(authResult.data.id, oldPassword, newPassword);
    if (!result.success) {
      console.error('[auth] changePassword failed:', result.error?.code, result.error?.message);
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
    const authResult = await authenticateToken(token);
    if (!authResult.success) {
      return res.status(401).json({ success: false, error: authResult.error });
    }

    const result = await getUserInfo(authResult.data.id);
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
    const authResult = await authenticateToken(token);
    if (!authResult.success) {
      return res.status(401).json({ success: false, error: authResult.error });
    }

    const { theme } = req.body;
    if (!theme || !['light', 'dark'].includes(theme)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '无效的主题值' } });
    }

    const result = await updateTheme(authResult.data.id, theme);
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
    const authResult = await authenticateToken(token);
    if (!authResult.success) {
      return res.status(401).json({ success: false, error: authResult.error });
    }

    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少用户名' } });
    }

    const result = await updateUsername(authResult.data.id, username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

export default router;
