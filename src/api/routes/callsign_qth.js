import express from 'express';
import { verifyToken } from '../auth.js';
import connector from '../../database/connector.js';

const router = express.Router();

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '未授权' } });
  }
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: '无效的令牌' } });
  }
  req.user = decoded;
  next();
}

router.get('/history', authMiddleware, async (req, res) => {
  try {
    const adapter = await connector.connect();
    const history = await adapter.getAllCallsignQthHistory();
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/history/:callsign', authMiddleware, async (req, res) => {
  try {
    const adapter = await connector.connect();
    const history = await adapter.getCallsignQthHistory(req.params.callsign);
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.post('/history', authMiddleware, async (req, res) => {
  try {
    const { callsign, qth } = req.body;
    if (!callsign || !qth) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少 callsign 或 qth' } });
    }
    const adapter = await connector.connect();
    const record = await adapter.addCallsignQthRecord(callsign, qth);
    res.json({ success: true, data: record });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.delete('/history', authMiddleware, async (req, res) => {
  try {
    const adapter = await connector.connect();
    await adapter.clearCallsignQthHistory();
    res.json({ success: true, data: { message: '历史记录已清空' } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

export default router;