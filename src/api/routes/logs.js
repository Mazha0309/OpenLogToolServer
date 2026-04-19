import express from 'express';
import { authenticateToken } from '../auth.js';
import { LogService, SyncService } from '../../services/index.js';

const router = express.Router();

const logService = new LogService();
const syncService = new SyncService();
await logService.init();
await syncService.init();

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '未授权' } });
  }
  const authResult = await authenticateToken(token);
  if (!authResult.success) {
    return res.status(401).json({ success: false, error: authResult.error });
  }
  req.user = authResult.data;
  next();
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, callsign, controller, deviceId } = req.query;
    const result = await logService.listLogs(
      { callsign, controller, deviceId },
      { page: parseInt(page), pageSize: parseInt(pageSize) },
      req.user.id
    );
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const log = await logService.getLog(req.params.id, req.user.id);
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
    const log = await logService.createLog(req.body, req.user.id);
    res.json({ success: true, data: log });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const log = await logService.updateLog(req.params.id, req.body, req.user.id);
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
    const deleted = await logService.deleteLog(req.params.id, req.user.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '日志不存在' } });
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

// Legacy sync path retained for older clients.
router.post('/sync/push', authMiddleware, async (req, res) => {
  try {
    const { logs, deviceId, dictionaries, callsignQthHistory } = req.body;
    if (!deviceId) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少 deviceId' } });
    }
    const userId = req.user.id;
    const result = await syncService.pushSync(logs, deviceId, userId, dictionaries, callsignQthHistory);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

// Legacy sync path retained for older clients.
router.get('/sync/pull', authMiddleware, async (req, res) => {
  try {
    const { deviceId, since } = req.query;
    if (!deviceId) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少 deviceId' } });
    }
    const userId = req.user.id;
    const result = await syncService.pullSync(deviceId, since || '1970-01-01T00:00:00.000Z', userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.post('/sync/bidirectional', authMiddleware, async (req, res) => {
  try {
    const { deviceId, lastSyncAt, payload } = req.body;
    if (!deviceId) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少 deviceId' } });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少 payload 或格式不正确' } });
    }
    if ('logs' in req.body || 'dictionaries' in req.body || 'callsignQthHistory' in req.body || 'history' in req.body) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: 'bidirectional sync 已升级为 payload + lastSyncAt 协议' } });
    }
    const userId = req.user.id;
    const result = await syncService.bidirectionalSync(payload, deviceId, userId, lastSyncAt || '1970-01-01T00:00:00.000Z');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

export default router;
export { authMiddleware };
