import express from 'express';
import { ShareService } from '../../services/index.js';
import { authMiddleware } from './logs.js';

const router = express.Router();

const shareService = new ShareService();
await shareService.init();

// Simple auth middleware copied from logs route to ensure req.user exists
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '未授权' } });
  }
  // reuse verifyToken by importing from auth.js if needed
  // Instead of duplicating, use existing middleware when possible
  if (typeof authMiddleware === 'function') {
    return authMiddleware(req, res, next);
  }
  next();
}

router.use(requireAuth);

// GET all shares where current user is either fromUserId or toUserId
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    const fromShares = userId ? await shareService.listShares({ fromUserId: userId }) : [];
    const toShares = userId ? await shareService.listShares({ toUserId: userId }) : [];
    const combined = [];
    const map = new Map();
    for (const s of [...fromShares, ...toShares]) {
      if (!map.has(s.id)) {
        map.set(s.id, true);
        combined.push(s);
      }
    }
    res.json({ success: true, data: combined });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

// POST create share
router.post('/', async (req, res) => {
  try {
    const { toUserId, shareType, itemIds } = req.body;
    if (!toUserId || !shareType) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少 toUserId 或 shareType' } });
    }
    const data = {
      fromUserId: req.user.id,
      toUserId,
      shareType,
      itemIds,
    };
    const share = await shareService.createShare(data);
    res.json({ success: true, data: share });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

// PUT update share
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { shareType, itemIds } = req.body;
    const share = await shareService.updateShare(id, { shareType, itemIds });
    if (!share) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '分享不存在' } });
    }
    res.json({ success: true, data: share });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

// DELETE share
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const ok = await shareService.deleteShare(id);
    if (!ok) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '分享不存在' } });
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

// GET logs shared with current user
router.get('/shared-logs', async (req, res) => {
  try {
    const toUserId = req.user.id;
    const logs = await shareService.listLogsSharedTo(toUserId);
    res.json({ success: true, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

// GET dictionaries shared with current user
router.get('/shared-dictionaries', async (req, res) => {
  try {
    const toUserId = req.user.id;
    const dicts = await shareService.listDictionariesSharedTo(toUserId);
    res.json({ success: true, data: dicts });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

export default router;
