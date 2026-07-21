import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getPublicSnapshot,
  getPublicWsTicket,
  getServerInfo,
  parsePublicEvent,
  ProtocolError,
  exchangePublicShare,
} from './api';
import type { PublicLink } from './link';
import type { FatalReason, LiveshareState, PublicLog, PublicSession } from './types';

type SocketOutcome =
  | 'retryBeforeReady'
  | 'retryAfterReady'
  | 'resync'
  | 'accessExpired'
  | 'revoked'
  | 'deleted'
  | 'stopped';

interface AccessGrant {
  accessToken: string;
  expiresAt: string;
  sessionId: string;
  shareExpiresAt: string;
}

const INITIAL_STATE: LiveshareState = {
  phase: 'initializing',
  logs: [],
  cursor: 0,
  retryAttempt: 0,
};

const SOCKET_CONNECT_TIMEOUT_MS = 15_000;
const SOCKET_PROGRESS_TIMEOUT_MS = 30_000;

function websocketUrl(ticket: string): string {
  const url = new URL('/ws/public', window.location.origin);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function retryDelay(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) return Math.max(250, retryAfterSeconds * 1_000);
  return Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
}

function isAccessInvalid(error: ApiError): boolean {
  return error.status === 401 || error.code === 'PUBLIC_ACCESS_INVALID';
}

function isSnapshotRequired(error: ApiError): boolean {
  return error.code === 'CURSOR_EXPIRED' || error.code === 'PUBLIC_SNAPSHOT_REQUIRED';
}

export function usePublicLiveshare(link: PublicLink): {
  state: LiveshareState;
  retryNow: () => void;
} {
  const [state, setState] = useState<LiveshareState>(() => (
    link.publicShareId && link.secret
      ? INITIAL_STATE
      : { ...INITIAL_STATE, phase: 'fatal', fatalReason: 'invalidLink' }
  ));
  const wakeRetryRef = useRef<(() => void) | null>(null);
  // One anonymous identifier per page lifetime lets the server count a real
  // page opening once without treating five-minute access-token renewal as a
  // new visitor. It is never persisted or reused across page loads.
  const [viewSessionId] = useState(() => crypto.randomUUID());

  const retryNow = useCallback(() => {
    wakeRetryRef.current?.();
  }, []);

  useEffect(() => {
    if (!link.publicShareId || !link.secret) return;

    const publicShareId = link.publicShareId;
    const secret = link.secret;
    const abortController = new AbortController();
    let stopped = false;
    let capabilityChecked = false;
    let access: AccessGrant | null = null;
    let session: PublicSession | undefined;
    let cursor = 0;
    let lastSyncedAt: string | undefined;
    let retryAttempt = 0;
    let realtimeFailureCount = 0;
    const logs = new Map<string, PublicLog>();

    const updateState = (patch: Partial<LiveshareState>, includeData = true) => {
      if (stopped) return;
      setState((previous) => ({
        ...previous,
        ...patch,
        ...(includeData
          ? {
              session,
              logs: [...logs.values()],
              cursor,
              lastSyncedAt,
              shareExpiresAt: access?.shareExpiresAt ?? previous.shareExpiresAt,
            }
          : {}),
      }));
    };

    const terminal = (fatalReason: FatalReason, clearRecords = false) => {
      if (clearRecords) logs.clear();
      updateState({ phase: 'fatal', fatalReason, retryAttempt: 0 });
    };

    const waitUntilOnline = async () => {
      if (navigator.onLine !== false) return;
      updateState({ phase: 'offline', retryAttempt });
      await new Promise<void>((resolve) => {
        const finish = () => {
          window.removeEventListener('online', finish);
          abortController.signal.removeEventListener('abort', finish);
          resolve();
        };
        window.addEventListener('online', finish, { once: true });
        abortController.signal.addEventListener('abort', finish, { once: true });
      });
    };

    const waitBeforeRetry = async (delay: number) => {
      updateState({
        phase: navigator.onLine === false
          ? 'offline'
          : session && realtimeFailureCount >= 2
            ? 'degraded'
            : 'reconnecting',
        retryAttempt,
      });
      await new Promise<void>((resolve) => {
        let resolved = false;
        const timer = window.setTimeout(finish, delay);
        function finish() {
          if (resolved) return;
          resolved = true;
          window.clearTimeout(timer);
          abortController.signal.removeEventListener('abort', finish);
          window.removeEventListener('online', finish);
          if (wakeRetryRef.current === finish) wakeRetryRef.current = null;
          resolve();
        }
        wakeRetryRef.current = finish;
        abortController.signal.addEventListener('abort', finish, { once: true });
        window.addEventListener('online', finish, { once: true });
      });
    };

    const applyEvent = (eventValue: unknown) => {
      const event = parsePublicEvent(eventValue);
      if (!session || event.sessionId !== session.sessionId) {
        throw new ProtocolError('Event Session does not match the snapshot');
      }
      if (event.seq <= cursor) return;
      if (event.seq !== cursor + 1) throw new ProtocolError('Event sequence gap');
      cursor = event.seq;
      lastSyncedAt = event.occurredAt;
      if (event.entityType === 'log') {
        const log = event.payload as PublicLog;
        if (event.entityId !== log.syncId) throw new ProtocolError('Event Log identity changed');
        if (event.type === 'log.deleted' || log.deletedAt !== null) logs.delete(log.syncId);
        else logs.set(log.syncId, log);
      } else {
        const nextSession = event.payload as PublicSession;
        if (event.entityId !== nextSession.sessionId || nextSession.sessionId !== session.sessionId) {
          throw new ProtocolError('Event Session identity changed');
        }
        session = nextSession;
      }
      return event;
    };

    const connectSocket = (
      ticket: string,
      onReady: () => void,
    ): Promise<SocketOutcome> => new Promise((resolve) => {
      let websocket: WebSocket;
      let finished = false;
      let stage: 'hello' | 'backlog' | 'live' = 'hello';
      let helloHead = -1;
      let sessionWasDeleted = false;
      let progressTimer: number | undefined;

      const clearProgressTimer = () => {
        if (progressTimer === undefined) return;
        window.clearTimeout(progressTimer);
        progressTimer = undefined;
      };

      const retryOutcome = (): SocketOutcome => (
        stage === 'live' ? 'retryAfterReady' : 'retryBeforeReady'
      );

      const armProgressTimer = (timeout: number) => {
        clearProgressTimer();
        progressTimer = window.setTimeout(
          () => finish(retryOutcome(), true),
          timeout,
        );
      };

      const finish = (outcome: SocketOutcome, closeSocket = false) => {
        if (finished) return;
        finished = true;
        clearProgressTimer();
        abortController.signal.removeEventListener('abort', stop);
        if (closeSocket && websocket.readyState < WebSocket.CLOSING) websocket.close();
        resolve(outcome);
      };
      const stop = () => finish('stopped', true);

      try {
        websocket = new WebSocket(websocketUrl(ticket));
      } catch {
        resolve('retryBeforeReady');
        return;
      }
      armProgressTimer(SOCKET_CONNECT_TIMEOUT_MS);
      abortController.signal.addEventListener('abort', stop, { once: true });

      websocket.onopen = () => {
        if (!finished) armProgressTimer(SOCKET_PROGRESS_TIMEOUT_MS);
      };

      websocket.onmessage = (message) => {
        if (finished) return;
        try {
          const value = JSON.parse(String(message.data)) as unknown;
          if (!isRecord(value) || typeof value.type !== 'string') {
            finish('resync', true);
            return;
          }
          if (value.type === 'accessRevoked') {
            const reason = typeof value.reason === 'string' ? value.reason : '';
            finish(reason === 'PUBLIC_ACCESS_EXPIRED' ? 'accessExpired' : 'revoked', true);
            return;
          }
          if (value.type === 'resyncRequired') {
            finish('resync', true);
            return;
          }
          if (value.type === 'hello') {
            if (
              stage !== 'hello' ||
              value.sessionId !== session?.sessionId ||
              !Number.isSafeInteger(value.headSeq) ||
              Number(value.headSeq) < cursor
            ) {
              finish('resync', true);
              return;
            }
            helloHead = Number(value.headSeq);
            stage = 'backlog';
            armProgressTimer(SOCKET_PROGRESS_TIMEOUT_MS);
            return;
          }
          if (value.type === 'event') {
            if (stage === 'hello') {
              finish('resync', true);
              return;
            }
            const event = applyEvent(value.event);
            if (event?.type === 'session.deleted' || session?.deletedAt) {
              sessionWasDeleted = true;
              logs.clear();
              updateState({ phase: 'ended', retryAttempt: 0 });
              finish('deleted', true);
              return;
            }
            if (stage === 'backlog') armProgressTimer(SOCKET_PROGRESS_TIMEOUT_MS);
            if (stage === 'live') updateState({ phase: 'live', retryAttempt: 0 });
            return;
          }
          if (value.type === 'ready') {
            if (
              stage !== 'backlog' ||
              !Number.isSafeInteger(value.cursor) ||
              Number(value.cursor) !== cursor ||
              cursor !== helloHead
            ) {
              finish('resync', true);
              return;
            }
            stage = 'live';
            clearProgressTimer();
            lastSyncedAt = new Date().toISOString();
            retryAttempt = 0;
            realtimeFailureCount = 0;
            updateState({ phase: 'live', retryAttempt: 0 });
            onReady();
            return;
          }
          finish('resync', true);
        } catch {
          finish('resync', true);
        }
      };
      websocket.onerror = () => undefined;
      websocket.onclose = (event) => {
        if (finished) return;
        if (sessionWasDeleted) {
          finish('deleted');
        } else if (event.code === 4009) {
          finish('resync');
        } else if (event.code === 4003 && event.reason.includes('EXPIRED')) {
          finish('accessExpired');
        } else if (event.code === 4003) {
          finish('revoked');
        } else {
          finish(retryOutcome());
        }
      };
    });

    const run = async () => {
      let needSnapshot = true;
      while (!stopped) {
        await waitUntilOnline();
        if (stopped) break;

        try {
          if (!capabilityChecked) {
            updateState({ phase: 'initializing', retryAttempt });
            const info = await getServerInfo(abortController.signal);
            if (info.protocolMin > 1 || info.protocolMax < 1 || !info.features.includes('publicLiveshare')) {
              terminal('unsupported');
              break;
            }
            capabilityChecked = true;
          }

          const tokenNearlyExpired = !access || Date.parse(access.expiresAt) <= Date.now() + 5_000;
          if (tokenNearlyExpired) {
            updateState({ phase: session ? 'reconnecting' : 'initializing', retryAttempt });
            access = await exchangePublicShare(
              publicShareId,
              secret,
              viewSessionId,
              abortController.signal,
            );
            if (Date.parse(access.shareExpiresAt) <= Date.now()) {
              terminal('unavailable', true);
              break;
            }
            if (session && access.sessionId !== session.sessionId) {
              terminal('protocolError', true);
              break;
            }
          }

          if (!access) throw new ProtocolError('Public access grant is missing');
          const currentAccess = access;

          if (needSnapshot) {
            updateState({ phase: 'loadingSnapshot', retryAttempt });
            const snapshot = await getPublicSnapshot(
              currentAccess.sessionId,
              currentAccess.accessToken,
              abortController.signal,
            );
            session = snapshot.session;
            cursor = snapshot.highWatermarkSeq;
            logs.clear();
            for (const log of snapshot.logs) logs.set(log.syncId, log);
            lastSyncedAt = new Date().toISOString();
            needSnapshot = false;
            updateState({ phase: 'connecting', retryAttempt });
          } else {
            updateState({ phase: 'connecting', retryAttempt });
          }

          const ticket = await getPublicWsTicket(
            currentAccess.sessionId,
            currentAccess.accessToken,
            cursor,
            abortController.signal,
          );
          const outcome = await connectSocket(ticket, () => {
            retryAttempt = 0;
          });
          if (outcome === 'stopped') break;
          if (outcome === 'deleted') {
            updateState({ phase: 'ended', retryAttempt: 0 });
            break;
          }
          if (outcome === 'revoked') {
            terminal('unavailable', true);
            break;
          }
          if (outcome === 'resync') needSnapshot = true;
          if (outcome === 'retryBeforeReady') {
            needSnapshot = true;
            realtimeFailureCount += 1;
          }
          if (outcome === 'accessExpired') access = null;
        } catch (error) {
          if (stopped || (error instanceof DOMException && error.name === 'AbortError')) break;
          if (error instanceof ProtocolError) {
            terminal('protocolError');
            break;
          }
          if (error instanceof ApiError) {
            if (!capabilityChecked && error.status === 404) {
              terminal('unsupported');
              break;
            }
            if (error.code === 'PUBLIC_SHARE_INVALID' || error.status === 404) {
              terminal('unavailable', true);
              break;
            }
            if (error.code === 'PUBLIC_SNAPSHOT_TOO_LARGE' || error.status === 413) {
              terminal('snapshotTooLarge');
              break;
            }
            if (isAccessInvalid(error)) {
              access = null;
              continue;
            }
            if (isSnapshotRequired(error)) {
              needSnapshot = true;
              continue;
            }
            retryAttempt += 1;
            await waitBeforeRetry(retryDelay(retryAttempt, error.retryAfterSeconds));
            continue;
          }
          retryAttempt += 1;
          await waitBeforeRetry(retryDelay(retryAttempt));
          continue;
        }

        if (!stopped) {
          retryAttempt += 1;
          await waitBeforeRetry(retryDelay(retryAttempt));
        }
      }
    };

    void run();
    return () => {
      stopped = true;
      abortController.abort();
      wakeRetryRef.current?.();
      wakeRetryRef.current = null;
    };
  }, [link.publicShareId, link.secret, viewSessionId]);

  return { state, retryNow };
}
