import Database from 'better-sqlite3';
import { Request, RequestHandler } from 'express';

export type RequestSurface =
  | 'sessionCatalog'
  | 'sessionLifecycle'
  | 'snapshot'
  | 'events'
  | 'mutations'
  | 'memberWsTicket'
  | 'membership'
  | 'invites'
  | 'publicShareAdmin'
  | 'publicExchange'
  | 'publicSnapshot'
  | 'publicWsTicket'
  | 'otherCollaboration'
  | 'otherApi';

export type WebSocketAudience = 'member' | 'public';
export type MutationMetricStatus = 'accepted' | 'conflict' | 'rejected';

const REQUEST_SURFACES: readonly RequestSurface[] = [
  'sessionCatalog',
  'sessionLifecycle',
  'snapshot',
  'events',
  'mutations',
  'memberWsTicket',
  'membership',
  'invites',
  'publicShareAdmin',
  'publicExchange',
  'publicSnapshot',
  'publicWsTicket',
  'otherCollaboration',
  'otherApi',
];

interface RequestSurfaceCounters {
  total: number;
  success: number;
  clientError: number;
  rateLimited: number;
  serverError: number;
  aborted: number;
  idempotentReplays: number;
  durationBucketsMs: {
    le10: number;
    le50: number;
    le100: number;
    le250: number;
    le500: number;
    le1000: number;
    le2500: number;
    le5000: number;
    gt5000: number;
  };
}

function requestSurfaceCounters(): RequestSurfaceCounters {
  return {
    total: 0,
    success: 0,
    clientError: 0,
    rateLimited: 0,
    serverError: 0,
    aborted: 0,
    idempotentReplays: 0,
    durationBucketsMs: {
      le10: 0,
      le50: 0,
      le100: 0,
      le250: 0,
      le500: 0,
      le1000: 0,
      le2500: 0,
      le5000: 0,
      gt5000: 0,
    },
  };
}

function requestSurfaceRecord(): Record<RequestSurface, RequestSurfaceCounters> {
  return Object.fromEntries(
    REQUEST_SURFACES.map((surface) => [surface, requestSurfaceCounters()]),
  ) as Record<RequestSurface, RequestSurfaceCounters>;
}

function requestSurface(req: Request): RequestSurface {
  const originalPath = req.originalUrl.split('?', 1)[0];
  const path = originalPath.length > 1
    ? originalPath.replace(/\/+$/, '')
    : originalPath;
  if (/^\/api\/v1\/public-shares\/[^/]+\/exchange$/.test(path)) return 'publicExchange';
  if (/^\/api\/v1\/public\/sessions\/[^/]+\/snapshot$/.test(path)) return 'publicSnapshot';
  if (/^\/api\/v1\/public\/sessions\/[^/]+\/ws-ticket$/.test(path)) return 'publicWsTicket';
  if (/^\/api\/v1\/sessions\/[^/]+\/public-shares(?:\/[^/]+)?$/.test(path)) {
    return 'publicShareAdmin';
  }
  if (path.startsWith('/api/v1/collaboration-invites')) return 'invites';
  if (!path.startsWith('/api/v1/sessions')) return 'otherApi';
  if (path === '/api/v1/sessions') return 'sessionCatalog';
  if (req.method === 'PUT' && /^\/api\/v1\/sessions\/[^/]+$/.test(path)) {
    return 'sessionLifecycle';
  }
  if (/^\/api\/v1\/sessions\/[^/]+\/snapshot$/.test(path)) return 'snapshot';
  if (/^\/api\/v1\/sessions\/[^/]+\/events$/.test(path)) return 'events';
  if (/^\/api\/v1\/sessions\/[^/]+\/mutations$/.test(path)) return 'mutations';
  if (/^\/api\/v1\/sessions\/[^/]+\/ws-ticket$/.test(path)) return 'memberWsTicket';
  if (/^\/api\/v1\/sessions\/[^/]+\/(?:membership|members|transfer-ownership)/.test(path)) {
    return 'membership';
  }
  if (/^\/api\/v1\/sessions\/[^/]+\/invites/.test(path)) return 'invites';
  if (/^\/api\/v1\/sessions\/[^/]+\/(?:bootstrap\/logs|activate)$/.test(path)) {
    return 'sessionLifecycle';
  }
  return 'otherCollaboration';
}

function recordDurationBucket(counters: RequestSurfaceCounters, durationMs: number): void {
  const buckets = counters.durationBucketsMs;
  if (durationMs <= 10) buckets.le10 += 1;
  if (durationMs <= 50) buckets.le50 += 1;
  if (durationMs <= 100) buckets.le100 += 1;
  if (durationMs <= 250) buckets.le250 += 1;
  if (durationMs <= 500) buckets.le500 += 1;
  if (durationMs <= 1_000) buckets.le1000 += 1;
  if (durationMs <= 2_500) buckets.le2500 += 1;
  if (durationMs <= 5_000) buckets.le5000 += 1;
  if (durationMs > 5_000) buckets.gt5000 += 1;
}

function websocketRecord(): Record<WebSocketAudience, number> {
  return { member: 0, public: 0 };
}

export class RuntimeMetrics {
  readonly startedAt = new Date().toISOString();
  private readonly startedAtMs = Date.now();
  private readonly requests = {
    total: 0,
    completed: 0,
    aborted: 0,
    inFlight: 0,
    rateLimited: 0,
    idempotentReplays: 0,
    bySurface: requestSurfaceRecord(),
  };
  private readonly mutations = {
    operationsReceived: 0,
    accepted: 0,
    conflict: 0,
    rejected: 0,
    replayed: 0,
  };
  private readonly events = {
    published: 0,
    session: 0,
    log: 0,
    restCatchupSent: 0,
    wsBacklogSent: websocketRecord(),
    wsLiveSent: websocketRecord(),
    deliveryFailures: 0,
  };
  private readonly websockets = {
    attempts: websocketRecord(),
    accepted: websocketRecord(),
    // A privacy-safe reconnect proxy: accepted sockets whose one-time ticket
    // resumes from a non-zero event cursor. It does not correlate client identity.
    cursorResumeAccepted: websocketRecord(),
    rejected: websocketRecord(),
    closed: websocketRecord(),
    active: websocketRecord(),
    resyncRequired: websocketRecord(),
    accessRevoked: websocketRecord(),
    controlDeliveryFailures: websocketRecord(),
  };

  requestMiddleware(): RequestHandler {
    return (req, res, next) => {
      if (!req.originalUrl.startsWith('/api/')) {
        next();
        return;
      }
      const surface = requestSurface(req);
      const started = process.hrtime.bigint();
      this.requests.total += 1;
      this.requests.inFlight += 1;
      const surfaceCounters = this.requests.bySurface[surface];
      surfaceCounters.total += 1;
      let recorded = false;
      const complete = (aborted: boolean) => {
        if (recorded) return;
        recorded = true;
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        this.requests.inFlight = Math.max(0, this.requests.inFlight - 1);
        recordDurationBucket(surfaceCounters, durationMs);
        if (aborted) {
          this.requests.aborted += 1;
          surfaceCounters.aborted += 1;
          return;
        }
        this.requests.completed += 1;
        const status = res.statusCode;
        if (res.getHeader('Idempotent-Replay') === 'true') {
          this.requests.idempotentReplays += 1;
          surfaceCounters.idempotentReplays += 1;
        }
        if (status === 429) {
          this.requests.rateLimited += 1;
          surfaceCounters.rateLimited += 1;
        }
        if (status < 400) surfaceCounters.success += 1;
        else if (status < 500) surfaceCounters.clientError += 1;
        else surfaceCounters.serverError += 1;
      };
      res.once('finish', () => complete(false));
      res.once('close', () => complete(true));
      next();
    };
  }

  recordMutationsReceived(count: number): void {
    this.mutations.operationsReceived += count;
  }

  recordMutationResult(status: MutationMetricStatus, replayed: boolean): void {
    this.mutations[status] += 1;
    if (replayed) this.mutations.replayed += 1;
  }

  recordEventCommitted(eventType: string): void {
    this.events.published += 1;
    if (eventType.startsWith('session.')) this.events.session += 1;
    else if (eventType.startsWith('log.')) this.events.log += 1;
  }

  recordRestCatchupSent(count: number): void {
    this.events.restCatchupSent += count;
  }

  recordWsBacklogSent(audience: WebSocketAudience): void {
    this.events.wsBacklogSent[audience] += 1;
  }

  recordWsLiveSent(audience: WebSocketAudience): void {
    this.events.wsLiveSent[audience] += 1;
  }

  recordEventDeliveryFailure(): void {
    this.events.deliveryFailures += 1;
  }

  recordWebSocketAttempt(audience: WebSocketAudience): void {
    this.websockets.attempts[audience] += 1;
  }

  recordWebSocketRejected(audience: WebSocketAudience): void {
    this.websockets.rejected[audience] += 1;
  }

  recordWebSocketAccepted(audience: WebSocketAudience, cursorResume: boolean): void {
    this.websockets.accepted[audience] += 1;
    if (cursorResume) this.websockets.cursorResumeAccepted[audience] += 1;
    this.websockets.active[audience] += 1;
  }

  recordWebSocketClosed(audience: WebSocketAudience): void {
    this.websockets.closed[audience] += 1;
    this.websockets.active[audience] = Math.max(0, this.websockets.active[audience] - 1);
  }

  recordWebSocketResync(audience: WebSocketAudience): void {
    this.websockets.resyncRequired[audience] += 1;
  }

  recordWebSocketRevoked(audience: WebSocketAudience): void {
    this.websockets.accessRevoked[audience] += 1;
  }

  recordWebSocketControlDeliveryFailure(audience: WebSocketAudience): void {
    this.websockets.controlDeliveryFailures[audience] += 1;
  }

  snapshot() {
    const memory = process.memoryUsage();
    return {
      scope: 'single-process' as const,
      startedAt: this.startedAt,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1_000)),
      process: {
        memoryBytes: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          external: memory.external,
        },
      },
      requests: {
        total: this.requests.total,
        completed: this.requests.completed,
        aborted: this.requests.aborted,
        inFlight: this.requests.inFlight,
        rateLimited: this.requests.rateLimited,
        idempotentReplays: this.requests.idempotentReplays,
        bySurface: Object.fromEntries(
          REQUEST_SURFACES.map((surface) => {
            const counters = this.requests.bySurface[surface];
            return [surface, {
              ...counters,
              durationBucketsMs: { ...counters.durationBucketsMs },
            }];
          }),
        ) as Record<RequestSurface, RequestSurfaceCounters>,
      },
      mutations: { ...this.mutations },
      events: {
        published: this.events.published,
        session: this.events.session,
        log: this.events.log,
        restCatchupSent: this.events.restCatchupSent,
        wsBacklogSent: { ...this.events.wsBacklogSent },
        wsLiveSent: { ...this.events.wsLiveSent },
        deliveryFailures: this.events.deliveryFailures,
      },
      websockets: {
        attempts: { ...this.websockets.attempts },
        accepted: { ...this.websockets.accepted },
        cursorResumeAccepted: { ...this.websockets.cursorResumeAccepted },
        rejected: { ...this.websockets.rejected },
        closed: { ...this.websockets.closed },
        active: { ...this.websockets.active },
        resyncRequired: { ...this.websockets.resyncRequired },
        accessRevoked: { ...this.websockets.accessRevoked },
        controlDeliveryFailures: { ...this.websockets.controlDeliveryFailures },
      },
    };
  }
}

const metricsByDatabase = new WeakMap<Database.Database, RuntimeMetrics>();

export function getRuntimeMetrics(db: Database.Database): RuntimeMetrics {
  let metrics = metricsByDatabase.get(db);
  if (!metrics) {
    metrics = new RuntimeMetrics();
    metricsByDatabase.set(db, metrics);
  }
  return metrics;
}
