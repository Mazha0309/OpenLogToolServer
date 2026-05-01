import express from 'express';
import connector from '../../database/connector.js';

const router = express.Router();

router.get('/state', async (req, res) => {
  try {
    const adapter = await connector.connect();
    const dbType = connector.getDbType();

    if (dbType !== 'memory') {
      return res.json({ ok: false, error: 'Debug only available with memory adapter' });
    }

    res.json({
      ok: true,
      dbType,
      sessions: adapter.sessions || [],
      logs: Array.from(adapter.logs?.values() || []),
      users: Array.from(adapter.users?.values() || []).map(u => ({ ...u, passwordHash: '***' })),
      devices: adapter.devices || [],
      publicLinks: adapter.publicLinks || [],
      changeLog: adapter.changeLog || [],
      histories: Array.from(adapter.histories?.values() || []),
      counts: {
        sessions: (adapter.sessions || []).length,
        logs: adapter.logs?.size || 0,
        users: adapter.users?.size || 0,
        publicLinks: (adapter.publicLinks || []).length,
        changeLog: (adapter.changeLog || []).length,
        nextChangeId: adapter.nextChangeId || 0,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
