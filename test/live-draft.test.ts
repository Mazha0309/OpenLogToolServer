import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { AppConfig } from '../src/config';
import { CollaborationEvent } from '../src/collaboration/events';
import {
  getLiveDraftLockManager,
  LiveDraftLockManager,
} from '../src/collaboration/live-draft';
import {
  LIVE_DRAFT_HISTORY_PREVIEW_TTL_MS,
  LiveDraftHistoryPreviewManager,
} from '../src/collaboration/live-draft-history-preview';
import { CollaborationControlMessage, getRealtimeHub, RealtimeConnection } from '../src/collaboration/realtime';
import { openDatabase } from '../src/db/database';

type JsonObject = Record<string, unknown>;

interface HttpResult {
  status: number;
  headers: Headers;
  body: JsonObject;
  text: string;
}

const config: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'live-draft-test-jwt-secret-46da86cc-1f80-47e6-bd7d-caf94712',
  jwtIssuer: 'openlogtool-live-draft-test',
  bootstrapSecret: 'live-draft-bootstrap-secret',
  inviteHmacKey: 'live-draft-invite-hmac-key-3afb844e-4bf6-4a09-bca4',
  publicShareHmacKey: 'live-draft-public-key-06922d50-7827-4e29-ad91',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

function assertObject(value: unknown, label: string): asserts value is JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

class ProbeConnection implements RealtimeConnection {
  readonly events: CollaborationEvent[] = [];
  readonly controls: CollaborationControlMessage[] = [];
  readonly sessionId: string;
  readonly userId?: string;
  readonly publicShareId?: string;
  readonly ipAddress = '127.0.0.1';
  revoked?: string;

  constructor(readonly audience: 'member' | 'public', sessionId: string, userId?: string) {
    this.sessionId = sessionId;
    this.userId = userId;
    if (audience === 'public') this.publicShareId = 'probe-public-share';
  }

  deliver(event: CollaborationEvent): void { this.events.push(event); }
  deliverControl(message: CollaborationControlMessage): void { this.controls.push(message); }
  revoke(reason: string): void { this.revoked = reason; }
  membershipChanged(): void { /* probe */ }
  sessionDeleted(): void { /* probe */ }
  close(): void { /* probe */ }
}

test('live draft field leases expire after 30 seconds and can be reacquired', () => {
  const manager = new LiveDraftLockManager();
  const nativeNow = Date.now;
  let now = Date.parse('2026-07-13T00:00:00.000Z');
  Date.now = () => now;
  try {
    const first = manager.acquire({ sessionId: 'lease-session', field: 'callsign', userId: 'user-one', username: 'one', deviceId: 'device-one' });
    assert.equal(Date.parse(first.lock.expiresAt) - now, 30_000);
    now += 30_001;
    assert.deepEqual(manager.list('lease-session'), []);
    const second = manager.acquire({ sessionId: 'lease-session', field: 'callsign', userId: 'user-two', username: 'two', deviceId: 'device-two' });
    assert.notEqual(second.lock.leaseId, first.lock.leaseId);
  } finally {
    Date.now = nativeNow;
  }
});

test('callsign history previews expire from memory after a short bounded lifetime', () => {
  const manager = new LiveDraftHistoryPreviewManager();
  const now = Date.parse('2026-07-13T00:00:00.000Z');
  const preview = manager.publish({
    sessionId: 'preview-session',
    draftId: 'preview-draft',
    deviceId: 'preview-device',
    callsign: 'BG5ABC',
    actor: { userId: 'preview-user', username: 'Preview User' },
    candidates: [{
      candidateId: 'preview-candidate',
      sourceTime: '2026-07-12T12:00:00.000Z',
      qth: 'Hangzhou',
      device: null,
      power: null,
      antenna: null,
      height: null,
    }],
    now,
  });
  assert.equal(
    Date.parse(preview.expiresAt),
    now + LIVE_DRAFT_HISTORY_PREVIEW_TTL_MS,
  );
  assert.equal(
    manager.get('preview-session', now + LIVE_DRAFT_HISTORY_PREVIEW_TTL_MS - 1)?.previewId,
    preview.previewId,
  );
  assert.equal(
    manager.get('preview-session', now + LIVE_DRAFT_HISTORY_PREVIEW_TTL_MS),
    undefined,
  );
});

describe('collaboration live draft v1', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  const sessionId = 'live-draft-session';
  const ownerId = 'live-draft-owner';
  const editorId = 'live-draft-editor';
  const viewerId = 'live-draft-viewer';
  const outsiderId = 'live-draft-outsider';
  const ownerDevice = '5a8c082d-28aa-4906-b53e-f3b89d765334';
  const editorDevice = '59d453eb-ded6-4bf2-acf5-0968b5ce02d7';
  const consumeLeasesPreference = 'openlogtool-consume-live-draft-leases';
  const memberProbe = new ProbeConnection('member', sessionId, viewerId);
  const publicProbe = new ProbeConnection('public', sessionId);

  function token(userId: string): string {
    return jwt.sign({ type: 'access', role: 'user' }, config.jwtSecret, {
      algorithm: 'HS256',
      subject: userId,
      jwtid: randomUUID(),
      issuer: config.jwtIssuer,
      audience: 'openlogtool-v1',
      expiresIn: 300,
    });
  }

  async function request(path: string, options: { method?: string; userId?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-request-id': randomUUID(),
        ...(options.userId ? { authorization: `Bearer ${token(options.userId)}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as JsonObject : {}, text };
  }

  function success(result: HttpResult, status = 200): JsonObject {
    assert.equal(result.status, status, result.text);
    return result.body;
  }

  function error(result: HttpResult, status: number, code: string): void {
    assert.equal(result.status, status, result.text);
    assertObject(result.body.error, 'error');
    assert.equal(result.body.error.code, code, result.text);
  }

  async function acquire(userId: string, deviceId: string, field: string): Promise<JsonObject> {
    const body = success(await request(`/api/v1/sessions/${sessionId}/live-draft/locks`, {
      method: 'POST', userId, body: { field, deviceId },
    }), 201);
    assertObject(body.lock, 'lock');
    assertObject(body.draft, 'lock acquisition draft');
    assert.equal(body.draft.sessionId, sessionId);
    assert.equal(typeof body.draft.draftId, 'string');
    assert.equal(typeof body.draft.version, 'number');
    assertObject(body.draft.fields, 'lock acquisition draft fields');
    assertObject(body.draft.fieldRevisions, 'lock acquisition draft field revisions');
    return body.lock;
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-live-draft-api-'));
    const path = join(directory, 'draft.db');
    db = openDatabase(path);
    config.dbPath = path;
    const now = new Date().toISOString();
    const insertUser = db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'hash', 'user', ?, ?)`);
    for (const id of [ownerId, editorId, viewerId, outsiderId]) insertUser.run(id, id, now, now);
    db.prepare(`INSERT INTO sessions (id, title, status, owner_user_id, version, event_seq, min_retained_seq, created_at, updated_at) VALUES (?, 'Live draft', 'active', ?, 1, 0, 0, ?, ?)`).run(sessionId, ownerId, now, now);
    const insertMember = db.prepare(`INSERT INTO session_members (id, session_id, user_id, role, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`);
    insertMember.run(randomUUID(), sessionId, ownerId, 'owner', now, now);
    insertMember.run(randomUUID(), sessionId, editorId, 'editor', now, now);
    insertMember.run(randomUUID(), sessionId, viewerId, 'viewer', now, now);
    server = createServer(createApp({ db, config }));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    getRealtimeHub(db).add(memberProbe);
    getRealtimeHub(db).add(publicProbe);
  });

  after(async () => {
    getRealtimeHub(db)?.closeAll();
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
    db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('current members read one persistent aggregate draft while Viewer remains read-only', async () => {
    const owner = success(await request(`/api/v1/sessions/${sessionId}/live-draft`, { userId: ownerId }));
    assert.equal(owner.currentOrdinal, 1);
    assert.equal(owner.totalRecords, 0);
    assert.equal(owner.previousRecord, null);
    assert.deepEqual(owner.locks, []);
    assertObject(owner.draft, 'draft');
    assert.equal(owner.draft.version, 1);
    assertObject(owner.draft.fields, 'draft.fields');
    assert.equal(owner.draft.fields.time, null);
    assert.equal(owner.draft.fields.rstSent, '59');
    assert.equal(owner.draft.fields.rstRcvd, '59');
    assert.equal((await request(`/api/v1/sessions/${sessionId}/live-draft`, { userId: viewerId })).status, 200);
    error(await request(`/api/v1/sessions/${sessionId}/live-draft?extra=1`, { userId: ownerId }), 422, 'VALIDATION_FAILED');
    error(await request(`/api/v1/sessions/${sessionId}/live-draft`, { userId: outsiderId }), 404, 'NOT_FOUND');
    error(await request(`/api/v1/sessions/${sessionId}/live-draft/locks`, { method: 'POST', userId: viewerId, body: { field: 'callsign', deviceId: ownerDevice } }), 403, 'FORBIDDEN');
    assert.equal(db.prepare('SELECT COUNT(*) FROM session_live_drafts WHERE session_id = ?').pluck().get(sessionId), 1);
  });

  test('callsign lease holders share ephemeral history previews and atomically apply one candidate', async () => {
    const historySessionId = 'live-draft-history-preview-session';
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO sessions (id, title, status, owner_user_id, version, event_seq, min_retained_seq, created_at, updated_at) VALUES (?, 'History preview', 'active', ?, 1, 0, 0, ?, ?)`).run(historySessionId, ownerId, now, now);
    const insertMember = db.prepare(`INSERT INTO session_members (id, session_id, user_id, role, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`);
    insertMember.run(randomUUID(), historySessionId, ownerId, 'owner', now, now);
    insertMember.run(randomUUID(), historySessionId, editorId, 'editor', now, now);
    insertMember.run(randomUUID(), historySessionId, viewerId, 'viewer', now, now);

    const historyMemberProbe = new ProbeConnection('member', historySessionId, viewerId);
    const historyPublicProbe = new ProbeConnection('public', historySessionId);
    const removeMemberProbe = getRealtimeHub(db).add(historyMemberProbe);
    const removePublicProbe = getRealtimeHub(db).add(historyPublicProbe);
    try {
      const initial = success(await request(`/api/v1/sessions/${historySessionId}/live-draft`, { userId: ownerId }));
      assertObject(initial.draft, 'history initial draft');
      assert.equal(initial.historyPreview, null);

      const callsignAcquisition = success(await request(`/api/v1/sessions/${historySessionId}/live-draft/locks`, {
        method: 'POST',
        userId: ownerId,
        body: { field: 'callsign', deviceId: ownerDevice },
      }), 201);
      assertObject(callsignAcquisition.lock, 'history callsign lock');
      const callsignLock = callsignAcquisition.lock;
      const callsignPatch = success(await request(`/api/v1/sessions/${historySessionId}/live-draft`, {
        method: 'PATCH',
        userId: ownerId,
        body: {
          deviceId: ownerDevice,
          clientSeq: 1,
          updates: [{
            field: 'callsign',
            value: 'bg5abc',
            expectedRevision: 0,
            leaseId: callsignLock.leaseId,
          }],
        },
      }));
      assertObject(callsignPatch.draft, 'history callsign draft');
      assert.equal(callsignPatch.draft.fields.callsign, 'BG5ABC');
      assert.equal(callsignPatch.draft.version, 2);

      const candidateId = randomUUID();
      const candidate = {
        candidateId,
        sourceTime: '2026-07-12T12:34:56.000Z',
        qth: '  Hangzhou Xiaoshan  ',
        device: 'IC-705',
        power: '5W',
        antenna: null,
        height: 'Rooftop',
      };
      const publishBody = {
        deviceId: ownerDevice,
        leaseId: callsignLock.leaseId,
        draftId: callsignPatch.draft.draftId,
        callsign: 'bg5abc',
        candidates: [candidate],
      };

      error(await request(`/api/v1/sessions/${historySessionId}/live-draft/history-preview`, {
        method: 'PUT',
        userId: editorId,
        body: { ...publishBody, deviceId: editorDevice },
      }), 409, 'LIVE_DRAFT_LOCK_REQUIRED');
      error(await request(`/api/v1/sessions/${historySessionId}/live-draft/history-preview`, {
        method: 'PUT',
        userId: ownerId,
        body: {
          ...publishBody,
          candidates: Array.from({ length: 11 }, (_, index) => ({
            ...candidate,
            candidateId: `candidate-${index}`,
          })),
        },
      }), 422, 'VALIDATION_FAILED');

      const controlsBeforePreview = historyMemberProbe.controls.length;
      const published = success(await request(`/api/v1/sessions/${historySessionId}/live-draft/history-preview`, {
        method: 'PUT',
        userId: ownerId,
        body: publishBody,
      }));
      assertObject(published.historyPreview, 'published history preview');
      assert.equal(published.historyPreview.draftId, callsignPatch.draft.draftId);
      assert.equal(published.historyPreview.deviceId, ownerDevice);
      assert.equal(published.historyPreview.callsign, 'BG5ABC');
      assert.equal(published.historyPreview.candidates.length, 1);
      assert.equal(published.historyPreview.candidates[0].candidateId, candidateId);
      assert.equal(published.historyPreview.candidates[0].qth, 'Hangzhou Xiaoshan');
      assert.ok(Date.parse(published.historyPreview.expiresAt) > Date.now());
      const previewControl = historyMemberProbe.controls.at(-1);
      assert.ok(previewControl, 'member must receive the history preview');
      assert.equal(previewControl.type, 'liveDraft.updated');
      assert.deepEqual(previewControl.updatedFields, []);
      assert.deepEqual(previewControl.historyPreview, published.historyPreview);
      assert.equal((previewControl.draft as JsonObject).version, 2);
      assert.ok(historyMemberProbe.controls.length > controlsBeforePreview);
      assert.equal(historyPublicProbe.controls.length, 0, 'public sockets must not receive history previews');

      const hydrated = success(await request(`/api/v1/sessions/${historySessionId}/live-draft`, { userId: editorId }));
      assert.deepEqual(hydrated.historyPreview, published.historyPreview);

      const qthLockResult = success(await request(`/api/v1/sessions/${historySessionId}/live-draft/locks`, {
        method: 'POST',
        userId: editorId,
        body: { field: 'qth', deviceId: editorDevice },
      }), 201);
      const deviceLockResult = success(await request(`/api/v1/sessions/${historySessionId}/live-draft/locks`, {
        method: 'POST',
        userId: editorId,
        body: { field: 'device', deviceId: editorDevice },
      }), 201);
      assertObject(qthLockResult.lock, 'history qth lock');
      assertObject(deviceLockResult.lock, 'history device lock');

      error(await request(`/api/v1/sessions/${historySessionId}/live-draft/history-preview/${published.historyPreview.previewId}/select`, {
        method: 'POST',
        userId: editorId,
        headers: { 'idempotency-key': randomUUID() },
        body: {
          deviceId: editorDevice,
          leaseId: callsignLock.leaseId,
          candidateId,
        },
      }), 403, 'LIVE_DRAFT_HISTORY_PREVIEW_NOT_OWNED');

      const controlsBeforeSelection = historyMemberProbe.controls.length;
      const selectPath = `/api/v1/sessions/${historySessionId}/live-draft/history-preview/${published.historyPreview.previewId}/select`;
      const selectKey = randomUUID();
      const selectBody = {
        deviceId: ownerDevice,
        leaseId: callsignLock.leaseId,
        candidateId,
      };
      const selected = success(await request(selectPath, {
        method: 'POST',
        userId: ownerId,
        headers: { 'idempotency-key': selectKey },
        body: selectBody,
      }));
      assert.deepEqual(selected.updatedFields, ['qth', 'device', 'power', 'height']);
      assert.deepEqual(selected.historyReuse, {
        previewId: published.historyPreview.previewId,
        candidateId,
        affectedFields: ['qth', 'device', 'power', 'height'],
      });
      assert.equal(selected.historyPreview, null);
      assert.equal(selected.draft.version, 3);
      assert.equal(selected.draft.fields.callsign, 'BG5ABC');
      assert.equal(selected.draft.fields.time, null, 'history source time must never refill the live draft time');
      assert.equal(selected.draft.fields.qth, 'Hangzhou Xiaoshan');
      assert.equal(selected.draft.fields.device, 'IC-705');
      assert.equal(selected.draft.fields.power, '5W');
      assert.equal(selected.draft.fields.height, 'Rooftop');
      assert.equal(selected.draft.fieldRevisions.qth, 1);
      assert.equal(selected.draft.fieldRevisions.device, 1);
      assert.equal(selected.draft.fieldRevisions.power, 1);
      assert.equal(selected.draft.fieldRevisions.height, 1);
      assert.deepEqual(new Set((selected.releasedLeases as JsonObject[]).map((lease) => lease.field)), new Set(['qth', 'device']));
      assert.deepEqual((selected.locks as JsonObject[]).map((lock) => lock.field), ['callsign']);

      const selectionControls = historyMemberProbe.controls.slice(controlsBeforeSelection);
      const reuseControl = selectionControls.find((control) => control.type === 'liveDraft.updated');
      assert.ok(reuseControl, 'member must receive the selected history candidate');
      assert.deepEqual(reuseControl.historyReuse, selected.historyReuse);
      assert.deepEqual(reuseControl.updatedFields, selected.updatedFields);
      assert.deepEqual(reuseControl.locks, selected.locks);
      assert.equal(reuseControl.historyPreview, null);
      assert.equal((reuseControl.draft as JsonObject).version, 3);
      const forcedReleases = selectionControls.filter((control) =>
        control.type === 'liveDraft.lockChanged' && control.action === 'released');
      assert.equal(forcedReleases.length, 2);
      assert.equal(historyPublicProbe.controls.length, 0, 'public sockets must not receive history reuse controls');

      const controlsBeforeReplay = historyMemberProbe.controls.length;
      const replayResult = await request(selectPath, {
        method: 'POST',
        userId: ownerId,
        headers: { 'idempotency-key': selectKey },
        body: selectBody,
      });
      assert.deepEqual(success(replayResult), selected);
      assert.equal(replayResult.headers.get('idempotent-replay'), 'true');
      assert.equal(
        historyMemberProbe.controls.length,
        controlsBeforeReplay,
        'idempotent selection replay must not rebroadcast controls',
      );

      error(await request(`/api/v1/sessions/${historySessionId}/live-draft`, {
        method: 'PATCH',
        userId: editorId,
        body: {
          deviceId: editorDevice,
          clientSeq: 1,
          updates: [{
            field: 'qth',
            value: 'Stale overwrite',
            expectedRevision: 0,
            leaseId: qthLockResult.lock.leaseId,
          }],
        },
      }), 409, 'LIVE_DRAFT_LOCK_REQUIRED');
      const afterSelection = success(await request(`/api/v1/sessions/${historySessionId}/live-draft`, { userId: viewerId }));
      assert.equal(afterSelection.historyPreview, null);
      assert.equal(afterSelection.draft.fields.qth, 'Hangzhou Xiaoshan');

      const republished = success(await request(`/api/v1/sessions/${historySessionId}/live-draft/history-preview`, {
        method: 'PUT',
        userId: ownerId,
        body: publishBody,
      }));
      assertObject(republished.historyPreview, 'republished history preview');
      getLiveDraftLockManager(db).clearFields(
        historySessionId,
        new Set(['callsign']),
      );
      success(await request(`/api/v1/sessions/${historySessionId}/live-draft/locks`, {
        method: 'POST',
        userId: editorId,
        body: { field: 'callsign', deviceId: editorDevice },
      }), 201);
      const transferredLeaseEnvelope = success(await request(
        `/api/v1/sessions/${historySessionId}/live-draft`,
        { userId: viewerId },
      ));
      assert.equal(
        transferredLeaseEnvelope.historyPreview,
        null,
        'GET must not hydrate a preview after the callsign lease transfers to another publisher',
      );
    } finally {
      removeMemberProbe();
      removePublicProbe();
    }
  });

  test('field leases isolate writers and PATCH uses revisions plus bounded serial replay', async () => {
    const callsign = await acquire(ownerId, ownerDevice, 'callsign');
    error(await request(`/api/v1/sessions/${sessionId}/live-draft/locks`, { method: 'POST', userId: editorId, body: { field: 'callsign', deviceId: editorDevice } }), 409, 'LIVE_DRAFT_FIELD_LOCKED');
    const time = await acquire(ownerId, ownerDevice, 'time');
    const controller = await acquire(ownerId, ownerDevice, 'controller');
    const renewed = success(await request(`/api/v1/sessions/${sessionId}/live-draft/locks/${time.leaseId}/renew`, { method: 'POST', userId: ownerId, body: { deviceId: ownerDevice } }));
    assertObject(renewed.lock, 'renewed lock');
    assert.equal(renewed.lock.leaseId, time.leaseId);
    const temporary = await acquire(ownerId, ownerDevice, 'device');
    assert.deepEqual(success(await request(`/api/v1/sessions/${sessionId}/live-draft/locks/${temporary.leaseId}`, { method: 'DELETE', userId: ownerId, body: { deviceId: ownerDevice } })), { released: true });
    const updateBody = {
      deviceId: ownerDevice,
      clientSeq: 7,
      updates: [
        { field: 'time', value: '2026-07-13T12:34:56.000Z', expectedRevision: 0, leaseId: time.leaseId },
        { field: 'controller', value: 'bg0ctrl', expectedRevision: 0, leaseId: controller.leaseId },
        { field: 'callsign', value: 'bg0test', expectedRevision: 0, leaseId: callsign.leaseId },
      ],
    };
    const updateResult = await request(`/api/v1/sessions/${sessionId}/live-draft`, { method: 'PATCH', userId: ownerId, body: updateBody });
    const updated = success(updateResult);
    assert.equal(updateResult.headers.get('preference-applied'), null);
    assert.equal(updated.replayed, false);
    assert.deepEqual(updated.updatedFields, ['time', 'controller', 'callsign']);
    assert.deepEqual(updated.releasedLeases, []);
    assertObject(updated.draft, 'draft');
    assert.equal(updated.draft.version, 2);
    assertObject(updated.draft.fields, 'fields');
    assert.equal(updated.draft.fields.controller, 'BG0CTRL');
    assert.equal(updated.draft.fields.callsign, 'BG0TEST');
    const updateControl = memberProbe.controls.at(-1);
    assert.ok(updateControl, 'member socket must receive the live draft update');
    assert.equal(updateControl.type, 'liveDraft.updated');
    assert.equal(updateControl.deviceId, ownerDevice);
    assert.equal(updateControl.clientSeq, 7);
    assert.deepEqual(updateControl.updatedFields, ['time', 'controller', 'callsign']);
    assert.deepEqual(updateControl.releasedLeases, []);
    const broadcastDraft = updateControl.draft;
    assertObject(broadcastDraft, 'broadcast draft');
    assert.equal(broadcastDraft.version, 2);
    assert.deepEqual(broadcastDraft, updated.draft);
    assert.deepEqual(broadcastDraft.fields, {
      time: '2026-07-13T12:34:56.000Z',
      controller: 'BG0CTRL',
      callsign: 'BG0TEST',
      rstSent: '59',
      rstRcvd: '59',
      qth: null,
      device: null,
      power: null,
      antenna: null,
      height: null,
      remarks: null,
    });
    assert.deepEqual(broadcastDraft.fieldRevisions, {
      time: 1,
      controller: 1,
      callsign: 1,
      rstSent: 0,
      rstRcvd: 0,
      qth: 0,
      device: 0,
      power: 0,
      antenna: 0,
      height: 0,
      remarks: 0,
    });
    assert.equal(publicProbe.controls.length, 0, 'public sockets must not receive draft controls');
    const locksAfterLegacyUpdate = success(await request(`/api/v1/sessions/${sessionId}/live-draft`, { userId: ownerId })).locks;
    assert.ok(Array.isArray(locksAfterLegacyUpdate));
    assert.equal(locksAfterLegacyUpdate.length, 3, 'PATCH without Prefer must retain legacy leases');
    const memberControls = memberProbe.controls.length;

    const replay = success(await request(`/api/v1/sessions/${sessionId}/live-draft`, { method: 'PATCH', userId: ownerId, body: updateBody }));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.updatedFields, ['time', 'controller', 'callsign']);
    assert.deepEqual(replay.releasedLeases, []);
    assert.equal(memberProbe.controls.length, memberControls, 'PATCH replay must not rebroadcast');

    const consumingBody = {
      ...updateBody,
      clientSeq: 8,
      updates: updateBody.updates.map((update) => ({ ...update, expectedRevision: 1 })),
    };
    const controlsBeforeConsume = memberProbe.controls.length;
    const consumingResult = await request(`/api/v1/sessions/${sessionId}/live-draft`, {
      method: 'PATCH',
      userId: ownerId,
      headers: { prefer: consumeLeasesPreference },
      body: consumingBody,
    });
    const consumed = success(consumingResult);
    assert.equal(consumingResult.headers.get('preference-applied'), consumeLeasesPreference);
    assert.equal(consumed.replayed, false);
    assert.deepEqual(consumed.updatedFields, ['time', 'controller', 'callsign']);
    assert.deepEqual(consumed.releasedLeases, [
      { field: 'time', leaseId: time.leaseId },
      { field: 'controller', leaseId: controller.leaseId },
      { field: 'callsign', leaseId: callsign.leaseId },
    ]);
    assertObject(consumed.draft, 'consumed draft');
    assert.equal(consumed.draft.version, 3);
    const locksAfterConsume = success(await request(`/api/v1/sessions/${sessionId}/live-draft`, { userId: ownerId })).locks;
    assert.deepEqual(locksAfterConsume, [], 'successful preferred PATCH must consume every used lease');
    const consumeControls = memberProbe.controls.slice(controlsBeforeConsume);
    const consumedUpdateControl = consumeControls.find((control) => control.type === 'liveDraft.updated');
    assert.ok(consumedUpdateControl, 'preferred PATCH must broadcast the update');
    assert.deepEqual(consumedUpdateControl.updatedFields, consumed.updatedFields);
    assert.deepEqual(consumedUpdateControl.releasedLeases, consumed.releasedLeases);
    assert.equal(consumedUpdateControl.deviceId, ownerDevice);
    assert.equal(consumedUpdateControl.clientSeq, 8);
    const releaseControls = consumeControls.filter((control) => control.type === 'liveDraft.lockChanged' && control.action === 'released');
    assert.equal(releaseControls.length, 3, 'legacy member clients must receive one release control per consumed lease');
    for (const released of consumed.releasedLeases as JsonObject[]) {
      assert.ok(releaseControls.some((control) => control.field === released.field && control.leaseId === released.leaseId));
    }
    assert.equal(publicProbe.controls.length, 0, 'preferred PATCH controls must remain member-only');
    const controlsAfterConsume = memberProbe.controls.length;

    const consumingReplayResult = await request(`/api/v1/sessions/${sessionId}/live-draft`, {
      method: 'PATCH',
      userId: ownerId,
      headers: { prefer: consumeLeasesPreference },
      body: consumingBody,
    });
    const consumingReplay = success(consumingReplayResult);
    assert.equal(consumingReplayResult.headers.get('preference-applied'), consumeLeasesPreference);
    assert.equal(consumingReplay.replayed, true);
    assert.deepEqual(consumingReplay.updatedFields, consumed.updatedFields);
    assert.deepEqual(consumingReplay.releasedLeases, consumed.releasedLeases);
    assert.equal(memberProbe.controls.length, controlsAfterConsume, 'preferred PATCH replay must not release or broadcast again');

    error(await request(`/api/v1/sessions/${sessionId}/live-draft`, { method: 'PATCH', userId: ownerId, headers: { prefer: consumeLeasesPreference }, body: { ...consumingBody, updates: [{ field: 'callsign', value: 'BG0OTHER', expectedRevision: 2, leaseId: callsign.leaseId }] } }), 409, 'LIVE_DRAFT_CLIENT_SEQ_REUSED');
    error(await request(`/api/v1/sessions/${sessionId}/live-draft`, { method: 'PATCH', userId: ownerId, headers: { prefer: consumeLeasesPreference }, body: { ...consumingBody, clientSeq: 10, updates: [{ field: 'callsign', value: 'BG0OTHER', expectedRevision: 2, leaseId: callsign.leaseId }] } }), 409, 'LIVE_DRAFT_CLIENT_SEQ_GAP');
    const conflictCallsign = await acquire(ownerId, ownerDevice, 'callsign');
    const fieldConflict = await request(`/api/v1/sessions/${sessionId}/live-draft`, { method: 'PATCH', userId: ownerId, headers: { prefer: consumeLeasesPreference }, body: { ...consumingBody, clientSeq: 9, updates: [{ field: 'callsign', value: 'BG0OTHER', expectedRevision: 0, leaseId: conflictCallsign.leaseId }] } });
    error(fieldConflict, 409, 'LIVE_DRAFT_FIELD_CONFLICT');
    assertObject(fieldConflict.body.error, 'field conflict error');
    assertObject(fieldConflict.body.error.details, 'field conflict details');
    assert.equal(fieldConflict.body.error.details.field, 'callsign');
    assert.equal(fieldConflict.body.error.details.currentRevision, 2);
    assert.equal(fieldConflict.body.error.details.draftVersion, 3);
    assert.equal(fieldConflict.body.error.details.draftId, consumed.draft.draftId);
    assert.deepEqual(fieldConflict.body.error.details.draft, consumed.draft);
    const locksAfterConflict = success(await request(`/api/v1/sessions/${sessionId}/live-draft`, { userId: ownerId })).locks;
    assert.ok(Array.isArray(locksAfterConflict));
    assert.equal(locksAfterConflict.length, 1, 'failed preferred PATCH must retain its lease');
    assert.equal(locksAfterConflict[0].leaseId, conflictCallsign.leaseId);
    assert.equal(db.prepare('SELECT COUNT(*) FROM live_draft_device_state WHERE session_id = ?').pluck().get(sessionId), 1);
  });

  test('commit is atomic/idempotent, resets the draft and exposes only canonical log events publicly', async () => {
    const syncId = 'live-draft-log-one';
    const mutationId = randomUUID();
    const commitBody = { deviceId: ownerDevice, expectedDraftVersion: 3, syncId };
    const foreignLock = await acquire(editorId, editorDevice, 'qth');
    const busyCanonical = success(await request(`/api/v1/sessions/${sessionId}/live-draft`, { userId: ownerId })).draft;
    assertObject(busyCanonical, 'canonical draft while busy');
    const busyCommit = await request(`/api/v1/sessions/${sessionId}/live-draft/commit`, { method: 'POST', userId: ownerId, headers: { 'idempotency-key': randomUUID() }, body: commitBody });
    error(busyCommit, 409, 'LIVE_DRAFT_BUSY');
    assertObject(busyCommit.body.error, 'busy commit error');
    assertObject(busyCommit.body.error.details, 'busy commit details');
    assert.equal(busyCommit.body.error.details.currentDraftId, busyCanonical.draftId);
    assert.equal(busyCommit.body.error.details.currentDraftVersion, busyCanonical.version);
    assert.deepEqual(busyCommit.body.error.details.draft, busyCanonical);
    assert.equal(busyCommit.body.error.details.locks.length, 1);
    assert.equal(busyCommit.body.error.details.locks[0].field, 'qth');
    success(await request(`/api/v1/sessions/${sessionId}/live-draft/locks/${foreignLock.leaseId}`, { method: 'DELETE', userId: editorId, body: { deviceId: editorDevice } }));
    const canonicalBeforeCommit = success(await request(`/api/v1/sessions/${sessionId}/live-draft`, { userId: ownerId })).draft;
    assertObject(canonicalBeforeCommit, 'canonical draft before commit');
    const commitConflict = await request(`/api/v1/sessions/${sessionId}/live-draft/commit`, {
      method: 'POST',
      userId: ownerId,
      headers: { 'idempotency-key': randomUUID() },
      body: { ...commitBody, expectedDraftVersion: 1, syncId: 'stale-commit' },
    });
    error(commitConflict, 409, 'LIVE_DRAFT_VERSION_CONFLICT');
    assertObject(commitConflict.body.error, 'commit conflict error');
    assertObject(commitConflict.body.error.details, 'commit conflict details');
    assert.equal(commitConflict.body.error.details.currentDraftId, canonicalBeforeCommit.draftId);
    assert.equal(commitConflict.body.error.details.currentDraftVersion, canonicalBeforeCommit.version);
    assert.deepEqual(commitConflict.body.error.details.draft, canonicalBeforeCommit);
    db.exec(`
      CREATE TRIGGER force_live_draft_event_failure
      BEFORE INSERT ON session_events
      WHEN NEW.mutation_id = 'forced-live-draft-event-failure'
      BEGIN
        SELECT RAISE(ABORT, 'forced live draft event failure');
      END;
    `);
    const failed = await request(`/api/v1/sessions/${sessionId}/live-draft/commit`, { method: 'POST', userId: ownerId, headers: { 'idempotency-key': 'forced-live-draft-event-failure' }, body: { ...commitBody, syncId: 'must-roll-back' } });
    assert.equal(failed.status, 500, failed.text);
    assert.equal(db.prepare(`SELECT COUNT(*) FROM logs WHERE session_id = ?`).pluck().get(sessionId), 0);
    assert.equal(db.prepare(`SELECT version FROM session_live_drafts WHERE session_id = ?`).pluck().get(sessionId), 3);
    assert.equal(db.prepare(`SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = 'forced-live-draft-event-failure'`).pluck().get(), 0);
    db.exec('DROP TRIGGER force_live_draft_event_failure');
    const beforeControls = memberProbe.controls.length;
    const committed = success(await request(`/api/v1/sessions/${sessionId}/live-draft/commit`, { method: 'POST', userId: ownerId, headers: { 'idempotency-key': mutationId }, body: commitBody }), 201);
    assertObject(committed.record, 'record');
    assert.equal(committed.record.callsign, 'BG0TEST');
    assert.equal(committed.record.createdBy, ownerId);
    assert.equal(committed.record.updatedBy, ownerId);
    assertObject(committed.nextDraft, 'nextDraft');
    assert.equal(committed.nextDraft.version, 4);
    assertObject(committed.nextDraft.fields, 'next fields');
    assert.equal(committed.nextDraft.fields.time, null);
    assert.equal(committed.nextDraft.fields.controller, 'BG0CTRL');
    assert.equal(committed.nextDraft.fields.callsign, null);
    assert.equal(committed.committedOrdinal, 1);
    assert.equal(committed.currentOrdinal, 2);
    assert.equal(committed.totalRecords, 1);
    assert.equal(db.prepare('SELECT COUNT(*) FROM logs WHERE session_id = ?').pluck().get(sessionId), 1);
    const committedAuthor = db.prepare(
      'SELECT created_by, updated_by FROM logs WHERE session_id = ? AND sync_id = ?',
    ).get(sessionId, syncId) as { created_by: string | null; updated_by: string | null };
    assert.equal(committedAuthor.created_by, ownerId);
    assert.equal(committedAuthor.updated_by, ownerId);
    assert.equal(db.prepare(`SELECT COUNT(*) FROM session_events WHERE session_id = ? AND type = 'log.created'`).pluck().get(sessionId), 1);
    assert.equal(db.prepare('SELECT COUNT(*) FROM live_draft_device_state WHERE session_id = ?').pluck().get(sessionId), 0);
    assert.equal(memberProbe.controls.length, beforeControls + 1);
    assert.equal(memberProbe.controls.at(-1)?.type, 'liveDraft.committed');
    assert.equal(memberProbe.controls.at(-1)?.deviceId, ownerDevice);
    assertObject(memberProbe.controls.at(-1)?.record, 'committed control record');
    assert.equal(memberProbe.controls.at(-1)?.record.createdBy, ownerId);
    assert.equal(memberProbe.controls.at(-1)?.record.updatedBy, ownerId);
    assert.equal(publicProbe.controls.length, 0);
    assert.equal(publicProbe.events.length, 1);
    assert.equal(publicProbe.events[0].type, 'log.created');
    assertObject(publicProbe.events[0].payload, 'created event payload');
    assert.equal(publicProbe.events[0].payload.createdBy, ownerId);
    assert.equal(publicProbe.events[0].payload.updatedBy, ownerId);

    const replayResult = await request(`/api/v1/sessions/${sessionId}/live-draft/commit`, { method: 'POST', userId: ownerId, headers: { 'idempotency-key': mutationId }, body: commitBody });
    const replay = success(replayResult, 201);
    assert.equal(replayResult.headers.get('idempotent-replay'), 'true');
    assert.deepEqual(replay, committed);
    assert.equal(publicProbe.events.length, 1);
    error(await request(`/api/v1/sessions/${sessionId}/live-draft/commit`, { method: 'POST', userId: editorId, headers: { 'idempotency-key': randomUUID() }, body: { deviceId: editorDevice, expectedDraftVersion: 3, syncId: 'late-log' } }), 409, 'LIVE_DRAFT_ALREADY_COMMITTED');
  });

  test('non-empty drafts block close; discard and membership revocation clear leases', async () => {
    const callsign = await acquire(ownerId, ownerDevice, 'callsign');
    const patched = success(await request(`/api/v1/sessions/${sessionId}/live-draft`, {
      method: 'PATCH', userId: ownerId,
      body: { deviceId: ownerDevice, clientSeq: 8, updates: [{ field: 'callsign', value: 'BG0UNSAVED', expectedRevision: 0, leaseId: callsign.leaseId }] },
    }));
    assertObject(patched.draft, 'draft');
    assert.equal(patched.draft.version, 5);

    const rejectedClose = success(await request(`/api/v1/sessions/${sessionId}/mutations`, {
      method: 'POST', userId: ownerId,
      body: { protocolVersion: 1, deviceId: ownerDevice, operations: [{ mutationId: randomUUID(), entityType: 'session', entityId: sessionId, operation: 'close', baseVersion: 1 }] },
    }));
    assert.ok(Array.isArray(rejectedClose.results));
    assertObject(rejectedClose.results[0], 'close result');
    assert.equal(rejectedClose.results[0].status, 'rejected');
    assert.equal(rejectedClose.results[0].code, 'LIVE_DRAFT_NOT_EMPTY');

    const discardKey = randomUUID();
    const discardBody = { deviceId: ownerDevice, expectedDraftVersion: 5 };
    const discardConflict = await request(`/api/v1/sessions/${sessionId}/live-draft`, {
      method: 'DELETE',
      userId: ownerId,
      headers: { 'idempotency-key': randomUUID() },
      body: { ...discardBody, expectedDraftVersion: 4 },
    });
    error(discardConflict, 409, 'LIVE_DRAFT_VERSION_CONFLICT');
    assertObject(discardConflict.body.error, 'discard conflict error');
    assertObject(discardConflict.body.error.details, 'discard conflict details');
    assert.equal(discardConflict.body.error.details.currentDraftId, patched.draft.draftId);
    assert.equal(discardConflict.body.error.details.currentDraftVersion, patched.draft.version);
    assert.deepEqual(discardConflict.body.error.details.draft, patched.draft);
    const discarded = success(await request(`/api/v1/sessions/${sessionId}/live-draft`, { method: 'DELETE', userId: ownerId, headers: { 'idempotency-key': discardKey }, body: discardBody }));
    assertObject(discarded.nextDraft, 'nextDraft');
    assert.equal(discarded.nextDraft.version, 6);
    assertObject(discarded.nextDraft.fields, 'next fields');
    assert.equal(discarded.nextDraft.fields.time, null);
    assert.equal(memberProbe.controls.at(-1)?.type, 'liveDraft.cleared');
    assert.equal(memberProbe.controls.at(-1)?.deviceId, ownerDevice);
    const discardReplay = await request(`/api/v1/sessions/${sessionId}/live-draft`, { method: 'DELETE', userId: ownerId, headers: { 'idempotency-key': discardKey }, body: discardBody });
    assert.equal(discardReplay.headers.get('idempotent-replay'), 'true');

    await acquire(editorId, editorDevice, 'qth');
    success(await request(`/api/v1/sessions/${sessionId}/members/${editorId}`, { method: 'DELETE', userId: ownerId, headers: { 'idempotency-key': randomUUID() } }));
    const afterRemoval = success(await request(`/api/v1/sessions/${sessionId}/live-draft`, { userId: ownerId }));
    assert.deepEqual(afterRemoval.locks, []);

    const acceptedClose = success(await request(`/api/v1/sessions/${sessionId}/mutations`, {
      method: 'POST', userId: ownerId,
      body: { protocolVersion: 1, deviceId: ownerDevice, operations: [{ mutationId: randomUUID(), entityType: 'session', entityId: sessionId, operation: 'close', baseVersion: 1 }] },
    }));
    assertObject(acceptedClose.results[0], 'close result');
    assert.equal(acceptedClose.results[0].status, 'accepted');
    error(await request(`/api/v1/sessions/${sessionId}/live-draft/locks`, { method: 'POST', userId: ownerId, body: { field: 'callsign', deviceId: ownerDevice } }), 409, 'SESSION_CLOSED');

    const deleted = success(await request(`/api/v1/sessions/${sessionId}/mutations`, {
      method: 'POST', userId: ownerId,
      body: { protocolVersion: 1, deviceId: ownerDevice, operations: [{ mutationId: randomUUID(), entityType: 'session', entityId: sessionId, operation: 'delete', baseVersion: 2 }] },
    }));
    assertObject(deleted.results[0], 'delete result');
    assert.equal(deleted.results[0].status, 'accepted');
    assert.equal(db.prepare('SELECT COUNT(*) FROM session_live_drafts WHERE session_id = ?').pluck().get(sessionId), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM live_draft_device_state WHERE session_id = ?').pluck().get(sessionId), 0);
  });
});
