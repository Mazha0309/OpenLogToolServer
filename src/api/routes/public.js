import express from 'express';
import connector from '../../database/connector.js';
import { LogRepository, SessionRepository } from '../../database/repository.js';

const router = express.Router();

router.get('/live/:shareCode', async (req, res) => {
  try {
    const adapter = await connector.connect();
    const link = await adapter.findPublicLinkByShareCode(req.params.shareCode);
    if (!link) return res.status(404).json({ ok: false, error: 'Link not found' });

    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return res.status(410).json({ ok: false, error: 'Link expired' });
    }

    const sessionRepo = new SessionRepository(adapter);
    const logRepo = new LogRepository(adapter);

    const session = await sessionRepo.findBySessionId(link.session_id);
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

    const logsResult = await logRepo.findAll(
      { sessionId: link.session_id },
      { page: 1, pageSize: 1000 }
    );
    const logs = logsResult.data || [];
    const latestLog = logs.length > 0
      ? logs.reduce((a, b) => new Date(a.updatedAt || a.updated_at || a.createdAt || a.created_at) > new Date(b.updatedAt || b.updated_at || b.createdAt || b.created_at) ? a : b)
      : null;

    const controller = latestLog?.controller || null;

    const result = {
      ok: true,
      serverTime: new Date().toISOString(),
      session: {
        session_id: session.session_id ?? session.sessionId,
        title: session.title,
        status: session.status,
        created_at: session.created_at || session.createdAt,
        updated_at: session.updated_at || session.updatedAt,
        closed_at: session.closed_at || session.closedAt || null,
      },
      controller: {
        callsign: controller,
        source: controller ? 'latest_log' : 'none',
      },
      logs: logs
        .filter(l => !l.deletedAt && !l.deleted_at)
        .map(l => ({
          sync_id: l.syncId ?? l.id,
          time: l.time,
          controller: l.controller,
          callsign: l.callsign,
          report: l.report,
          qth: l.qth,
          device: l.device,
          power: l.power,
          antenna: l.antenna,
          height: l.height,
          created_at: l.createdAt || l.created_at,
          updated_at: l.updatedAt || l.updated_at,
        })),
      meta: {
        total: logs.length,
        lastUpdatedAt: new Date().toISOString(),
        readonly: true,
      },
    };
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
