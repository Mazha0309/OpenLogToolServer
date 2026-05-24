import express from 'express';
import { ShareService, SyncService } from '../../services/index.js';
import { authMiddleware } from './logs.js';

const router = express.Router();
const shareService = new ShareService();
await shareService.init();
const syncService = new SyncService();
await syncService.init();

router.use(authMiddleware);

// Create a share invite for a session → returns shareCode
router.post('/', async (req, res) => {
  try {
    const { sessionId, permission } = req.body;
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_SESSION', message: '缺少 sessionId' } });
    }

    const share = await shareService.repo.create({
      fromUserId: req.user.id,
      sessionId,
      permission: permission || 'readwrite',
    });

    res.json({ ok: true, data: { shareCode: share.shareCode, shareId: share.id } });
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

// Join a share by shareCode
router.post('/join', async (req, res) => {
  try {
    const { shareCode } = req.body;
    if (!shareCode) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_CODE', message: '缺少 shareCode' } });
    }

    const share = await shareService.repo.findByCode(shareCode.toUpperCase());
    if (!share) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '分享码无效或已过期' } });
    }

    const updated = await shareService.repo.update(share.id, {
      toUserId: req.user.id,
      status: 'active',
    });

    // Fetch session info so the joiner can display it immediately
    const session = share.sessionId
      ? await syncService.sessionRepo.findBySessionId(share.sessionId)
      : null;

    res.json({
      ok: true,
      data: {
        shareId: updated.id,
        sessionId: share.sessionId,
        sessionTitle: session?.title || '',
        ownerId: share.fromUserId,
        permission: share.permission,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

// List shares for current user (both sent and received)
router.get('/', async (req, res) => {
  try {
    const shares = await shareService.repo.findForUser(req.user.id);
    res.json({ ok: true, data: shares });
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

// Revoke / cancel a share
router.delete('/:id', async (req, res) => {
  try {
    const share = await shareService.repo.findById(req.params.id);
    if (!share) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '分享不存在' } });
    }
    if (share.fromUserId !== req.user.id && share.toUserId !== req.user.id) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: '无权操作' } });
    }
    await shareService.repo.update(req.params.id, { status: 'revoked' });
    res.json({ ok: true, data: { deleted: true } });
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

export default router;
