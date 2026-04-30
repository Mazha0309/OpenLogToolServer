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
    return res.status(401).json({ ok: false, error: { code: 'SYNC_UNAUTHORIZED', message: '未授权' } });
  }
  const authResult = await authenticateToken(token);
  if (!authResult.success) {
    return res.status(401).json({ ok: false, error: { code: 'SYNC_UNAUTHORIZED', message: authResult.error?.message || 'token 无效' } });
  }
  req.user = authResult.data;
  next();
}

// GET /logs - list
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

// Sync routes (must be before /:id)
router.post('/sync/push', authMiddleware, async (req, res) => {
  try {
    const { deviceId, payload } = req.body;
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: { code: 'SYNC_DEVICE_ID_REQUIRED', message: '缺少 deviceId' } });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ ok: false, error: { code: 'SYNC_INVALID_PAYLOAD', message: '缺少 payload 或格式不正确' } });
    }
    const userId = req.user.id;
    const result = await syncService.pushSync(payload, deviceId, userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'SYNC_INTERNAL_ERROR', message: error.message } });
  }
});

router.get('/sync/pull', authMiddleware, async (req, res) => {
  try {
    const { since } = req.query;
    const userId = req.user.id;
    const result = await syncService.pullSync(since || '1970-01-01T00:00:00.000Z', userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'SYNC_INTERNAL_ERROR', message: error.message } });
  }
});

router.post('/sync/bidirectional', authMiddleware, async (req, res) => {
  try {
    const { deviceId, lastSyncAt, payload } = req.body;
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: { code: 'SYNC_DEVICE_ID_REQUIRED', message: '缺少 deviceId' } });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ ok: false, error: { code: 'SYNC_INVALID_PAYLOAD', message: '缺少 payload 或格式不正确' } });
    }
    if (lastSyncAt && isNaN(new Date(lastSyncAt).getTime())) {
      return res.status(400).json({ ok: false, error: { code: 'SYNC_INVALID_TIMESTAMP', message: 'lastSyncAt 时间格式错误' } });
    }
    const userId = req.user.id;
    const result = await syncService.bidirectionalSync(payload, deviceId, userId, lastSyncAt || '1970-01-01T00:00:00.000Z');
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'SYNC_INTERNAL_ERROR', message: error.message } });
  }
});

// Sessions routes (must be before /:id)
router.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const sessions = await syncService.sessionRepo.findAll(req.user.id);
    res.json({ ok: true, data: sessions });
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'SYNC_INTERNAL_ERROR', message: error.message } });
  }
});

router.get('/sessions/:sessionId/logs', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { page = 1, pageSize = 50 } = req.query;
    const result = await logService.listLogs(
      { sessionId },
      { page: parseInt(page), pageSize: parseInt(pageSize) },
      req.user.id
    );
    res.json({ ok: true, data: result });
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'SYNC_INTERNAL_ERROR', message: error.message } });
  }
});

// CRUD routes (after named routes to avoid /:id matching /sessions, /sync, etc.)
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

export default router;
export { authMiddleware };
