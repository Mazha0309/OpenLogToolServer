import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticateToken } from '../auth.js';
import { LogService, SyncService } from '../../services/index.js';
import connector from '../../database/connector.js';
import { LogRepository } from '../../database/repository.js';
import { wsManager } from '../../services/ws-manager.js';

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

router.delete('/sessions/:sessionId', authMiddleware, async (req, res) => {
  try {
    await syncService.sessionRepo.softDelete(
      req.params.sessionId,
      new Date().toISOString(),
      req.user.id
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'SYNC_INTERNAL_ERROR', message: error.message } });
  }
});

router.post('/sessions/:sessionId/public-link', authMiddleware, async (req, res) => {
  try {
    const adapter = await connector.connect();
    const expiresIn = parseInt(req.body.expiresIn) || 24;
    const expiresAt = new Date(Date.now() + expiresIn * 3600000);
    const link = await adapter.upsertPublicLink({
      session_id: req.params.sessionId,
      user_id: req.user.id,
      share_code: uuidv4().substring(0, 12),
      enabled: 1,
      created_at: new Date(),
      updated_at: new Date(),
      expires_at: expiresAt,
    });
    const url = `${req.protocol}://${req.get('host')}/live/${link.share_code}`;
    res.json({ ok: true, url, shareCode: link.share_code, sessionId: req.params.sessionId, expiresAt: expiresAt.toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/sessions/:sessionId/logs/upsert', authMiddleware, async (req, res) => {
  try {
    const { log } = req.body;
    const adapter = await connector.connect();
    const logRepo = new LogRepository(adapter);
    const result = await logRepo.upsert(log, req.body.deviceId, req.user.id);

    const changeEntry = {
      session_id: req.params.sessionId,
      entity_type: 'log',
      entity_sync_id: log.sync_id,
      action: 'upsert',
      payload_json: JSON.stringify(result),
      source_device_id: req.body.deviceId,
      server_created_at: new Date().toISOString(),
    };
    const inserted = await adapter.insertChangeLog(changeEntry);

    wsManager.broadcast(req.params.sessionId, {
      type: 'log.upserted',
      session_id: req.params.sessionId,
      change_id: inserted.change_id,
      source_device_id: req.body.deviceId,
      log: result,
    });

    res.json({ ok: true, change_id: inserted.change_id, log: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/sessions/:sessionId/logs/:syncId', authMiddleware, async (req, res) => {
  try {
    const adapter = await connector.connect();
    const logRepo = new LogRepository(adapter);
    await logRepo.softDelete(req.params.syncId, new Date().toISOString(), req.user.id);

    const changeEntry = {
      session_id: req.params.sessionId,
      entity_type: 'log',
      entity_sync_id: req.params.syncId,
      action: 'delete',
      payload_json: JSON.stringify({
        sync_id: req.params.syncId,
        deleted_at: new Date().toISOString(),
      }),
      source_device_id: req.body.deviceId,
      server_created_at: new Date().toISOString(),
    };
    const inserted = await adapter.insertChangeLog(changeEntry);

    wsManager.broadcast(req.params.sessionId, {
      type: 'log.deleted',
      session_id: req.params.sessionId,
      change_id: inserted.change_id,
      source_device_id: req.body.deviceId,
      sync_id: req.params.syncId,
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    res.json({ ok: true, change_id: inserted.change_id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/sessions/:sessionId/changes', authMiddleware, async (req, res) => {
  try {
    const adapter = await connector.connect();
    const since = parseInt(req.query.since) || 0;
    const changes = await adapter.getChangesSince(req.params.sessionId, since);
    res.json({
      ok: true,
      changes,
      next_change_id: changes.length > 0
        ? changes[changes.length - 1].change_id
        : since,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
