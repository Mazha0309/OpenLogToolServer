import express from 'express';
import { authenticateToken } from '../auth.js';
import { AuthService, DeviceService, LogService, DictionaryService, ShareService } from '../../services/index.js';
import { SyncRecordRepository } from '../../database/index.js';
import connector from '../../database/connector.js';
import { getConfig, writeConfig } from '../../config/index.js';
import { restartServer } from '../../../server/index.js';

const router = express.Router();
const authService = new AuthService();
const deviceService = new DeviceService();
const logService = new LogService();
const dictionaryService = new DictionaryService();
const shareService = new ShareService();
await authService.init();
await deviceService.init();
await logService.init();
await dictionaryService.init();

router.get('/server-info', adminMiddleware, async (req, res) => {
  try {
    const dbType = connector.getDbType();
    const adapterType = dbType === 'memory' ? '内存数据库 (Memory)' :
                         dbType === 'mysql' ? 'MySQL' :
                         dbType === 'mongodb' ? 'MongoDB' : dbType;

    res.json({
      success: true,
      data: {
        dbType,
        adapterType,
        version: process.env.npm_package_version || '0.3.0',
        nodeVersion: process.version,
        uptime: process.uptime(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/config', adminMiddleware, async (req, res) => {
  try {
    const config = getConfig();
    res.json({
      success: true,
      data: {
        dbType: config.DB_TYPE,
        dbHost: config.DB_HOST,
        dbPort: config.DB_PORT,
        dbUser: config.DB_USER,
        dbName: config.DB_NAME,
        dbPassword: config.DB_PASSWORD ? '********' : '',
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.put('/config', adminMiddleware, async (req, res) => {
  try {
    const { dbType, dbHost, dbPort, dbUser, dbPassword, dbName } = req.body;
    const updates = {};
    if (dbType !== undefined) updates.DB_TYPE = dbType;
    if (dbHost !== undefined) updates.DB_HOST = dbHost;
    if (dbPort !== undefined) updates.DB_PORT = String(dbPort);
    if (dbUser !== undefined) updates.DB_USER = dbUser;
    if (dbPassword !== undefined && dbPassword !== '********') updates.DB_PASSWORD = dbPassword;
    if (dbName !== undefined) updates.DB_NAME = dbName;

    const newConfig = writeConfig(updates);
    res.json({
      success: true,
      data: {
        dbType: newConfig.DB_TYPE,
        dbHost: newConfig.DB_HOST,
        dbPort: newConfig.DB_PORT,
        dbUser: newConfig.DB_USER,
        dbName: newConfig.DB_NAME,
        dbPassword: newConfig.DB_PASSWORD ? '********' : '',
        needsRestart: updates.DB_TYPE !== undefined,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.post('/restart', adminMiddleware, async (req, res) => {
  try {
    console.log('[管理员操作] 请求重启服务器');
    res.json({ success: true, data: { message: '服务器正在优雅重启中，请稍候...' } });
    setTimeout(() => {
      restartServer();
    }, 100);
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

async function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '未授权' } });
  }
  const authResult = await authenticateToken(token);
  if (!authResult.success) {
    return res.status(401).json({ success: false, error: authResult.error });
  }
  if (authResult.data.role !== 'admin') {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: '需要管理员权限' } });
  }
  req.user = authResult.data;
  next();
}

router.get('/stats', adminMiddleware, async (req, res) => {
  try {
    const devices = await deviceService.listDevices();
    const logsResult = await logService.listLogs({}, { page: 1, pageSize: 1000000 });
    const logs = logsResult.data || [];
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    const todayLogs = logs.filter(l => new Date(l.createdAt) >= todayStart).length;
    const weekLogs = logs.filter(l => new Date(l.createdAt) >= weekStart).length;

    res.json({
      success: true,
      data: {
        totalLogs: logsResult.total || logs.length,
        totalDevices: devices.length,
        todayLogs,
        weekLogs,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/sync-logs', adminMiddleware, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const adapter = await connector.connect();
    const syncRecordRepo = new SyncRecordRepository(adapter);
    const records = await syncRecordRepo.findRecent(parseInt(limit, 10));
    res.json({ success: true, data: records });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/logs', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, userId, callsign, controller } = req.query;
    const query = {};
    if (userId) query.userId = userId;
    if (callsign) query.callsign = callsign;
    if (controller) query.controller = controller;
    const result = await logService.listLogs(query, { page: parseInt(page), pageSize: parseInt(pageSize) });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/dictionaries', adminMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, userId, type, search } = req.query;
    const query = {};
    if (userId) query.userId = userId;
    if (search) query.search = search;
    const result = await dictionaryService.listDictionaries(type, query);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

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

router.get('/devices', adminMiddleware, async (req, res) => {
  try {
    const devices = await deviceService.listDevices();
    res.json({ success: true, data: devices });
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
    const authResult = await authenticateToken(token);
    if (!authResult.success) {
      return res.status(401).json({ success: false, error: authResult.error });
    }

    const subAccounts = await authService.getSubAccounts(authResult.data.id);
    res.json({ success: true, data: subAccounts });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/shares/:userId', adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const shares = await shareService.getSharesByUser(userId);
    const sent = shares.sent || [];

    const shareSettings = {};
    const itemIds = { logs: [], dictionaries: [], history: [] };
    const autoSync = { logs: false, dictionaries: false, history: false };

    for (const share of sent) {
      shareSettings[share.toUserId] = { enabled: true };
      if (share.shareType === 'logs' || share.shareType === 'both') {
        itemIds.logs = share.itemIds || [];
        autoSync.logs = share.autoSync || false;
      }
      if (share.shareType === 'dictionaries' || share.shareType === 'both') {
        itemIds.dictionaries = share.itemIds || [];
        autoSync.dictionaries = share.autoSync || false;
      }
      if (share.shareType === 'history') {
        itemIds.history = share.itemIds || [];
        autoSync.history = share.autoSync || false;
      }
    }

    res.json({
      success: true,
      data: {
        shareSettings,
        itemIds,
        autoSync,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.put('/shares/:userId', adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { shareType, itemIds, toUserIds, autoSync } = req.body;
    await shareService.updateShareConfig(userId, shareType, itemIds, toUserIds, autoSync);
    res.json({ success: true, data: { message: '共享配置已更新' } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.delete('/shares/:userId/:targetUserId', adminMiddleware, async (req, res) => {
  try {
    const { userId, targetUserId } = req.params;
    const shares = await shareService.repo.findByFromUser(userId);
    const share = shares.find(s => s.toUserId === targetUserId);
    if (!share) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '共享关系不存在' } });
    }
    await shareService.deleteShare(share.id);
    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

export default router;
