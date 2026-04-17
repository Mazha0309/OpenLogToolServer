import express from 'express';
import { verifyToken } from '../auth.js';
import { LogService, SyncService } from '../../services/index.js';

const router = express.Router();

const logService = new LogService();
const syncService = new SyncService();
await logService.init();
await syncService.init();

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

router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, callsign, controller, deviceId } = req.query;
    const result = await logService.listLogs(
      { callsign, controller, deviceId },
      { page: parseInt(page), pageSize: parseInt(pageSize) }
    );
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const log = await logService.getLog(req.params.id);
    if (!log) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '日志不存在' } });
    }
    res.json({ success: true, data: log });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const log = await logService.createLog(req.body);
    res.json({ success: true, data: log });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const log = await logService.updateLog(req.params.id, req.body);
    if (!log) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '日志不存在' } });
    }
    res.json({ success: true, data: log });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const deleted = await logService.deleteLog(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '日志不存在' } });
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.post('/sync/push', async (req, res) => {
  try {
    const { logs, deviceId } = req.body;
    if (!logs || !deviceId) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少 logs 或 deviceId' } });
    }
    const result = await syncService.pushSync(logs, deviceId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/sync/pull', async (req, res) => {
  try {
    const { deviceId, since } = req.query;
    if (!deviceId) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少 deviceId' } });
    }
    const result = await syncService.pullSync(deviceId, since || '1970-01-01T00:00:00.000Z');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.post('/sync/bidirectional', async (req, res) => {
  try {
    const { logs, deviceId } = req.body;
    if (!logs || !deviceId) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少 logs 或 deviceId' } });
    }
    const result = await syncService.bidirectionalSync(logs, deviceId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

export default router;
export { authMiddleware };
