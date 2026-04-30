// migrations/history-to-sessions.js
import { createHash } from 'crypto';
import connector from '../src/database/connector.js';
import { HistoryRepository, SessionRepository } from '../src/database/repository.js';

function migrationSessionId(historySyncId) {
  const raw = `history-migration:${historySyncId}`;
  return createHash('sha256').update(raw).digest('hex').substring(0, 32);
}

async function migrate() {
  const adapter = await connector.connect();
  const historyRepo = new HistoryRepository(adapter);
  const sessionRepo = new SessionRepository(adapter);

  const histories = await historyRepo.findAll();

  let count = 0;
  for (const h of histories) {
    const syncId = h.sync_id || h.syncId;
    if (!syncId) continue;

    const sessionId = migrationSessionId(syncId);
    const existing = await sessionRepo.findBySessionId(sessionId);
    if (existing) continue;

    await sessionRepo.upsert({
      session_id: sessionId,
      title: h.name || '未命名记录',
      status: 'closed',
      created_at: h.created_at || h.createdAt || new Date().toISOString(),
      updated_at: h.updated_at || h.updatedAt || new Date().toISOString(),
      closed_at: h.created_at || h.createdAt || new Date().toISOString(),
      source_device_id: h.source_device_id || h.sourceDeviceId || null,
    }, h.user_id || h.userId);

    count++;
    console.log(`Migrated history ${syncId} → session ${sessionId}`);
  }

  console.log(`Migration complete: ${count}/${histories.length} histories → sessions`);
  await connector.disconnect();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});