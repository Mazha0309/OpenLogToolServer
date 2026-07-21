import Database from 'better-sqlite3';
import { Request, RequestHandler } from 'express';
import { readFileSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type RequestSurface =
  | 'sessionCatalog'
  | 'sessionLifecycle'
  | 'snapshot'
  | 'events'
  | 'mutations'
  | 'liveDraft'
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
  'liveDraft',
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
  if (/^\/api\/v1\/sessions\/[^/]+\/live-draft(?:\/.*)?$/.test(path)) return 'liveDraft';
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

interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

interface RuntimeCpuSample {
  capturedAt: bigint;
  process: NodeJS.CpuUsage;
  system: CpuTimes[];
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function boundedPercent(value: number, maximum = 100): number {
  return Math.min(maximum, finiteNonNegative(value));
}

function readSystemCpuTimes(): CpuTimes[] {
  return cpus().map(({ times }) => ({
    user: finiteNonNegative(times.user),
    nice: finiteNonNegative(times.nice),
    sys: finiteNonNegative(times.sys),
    idle: finiteNonNegative(times.idle),
    irq: finiteNonNegative(times.irq),
  }));
}

function captureRuntimeCpuSample(): RuntimeCpuSample {
  return {
    capturedAt: process.hrtime.bigint(),
    process: process.cpuUsage(),
    system: readSystemCpuTimes(),
  };
}

function logicalCpuCount(sample: CpuTimes[]): number {
  return Math.max(1, sample.length);
}

function elapsedMilliseconds(previous: bigint, current: bigint): number {
  if (current <= previous) return 0;
  return finiteNonNegative(Number(current - previous) / 1_000_000);
}

function processCpuSnapshot(
  previous: RuntimeCpuSample,
  current: RuntimeCpuSample,
  sampleWindowMs: number,
) {
  const userDelta = Math.max(0, current.process.user - previous.process.user);
  const systemDelta = Math.max(0, current.process.system - previous.process.system);
  const usedMicroseconds = userDelta + systemDelta;
  const count = logicalCpuCount(current.system);
  const percentOfOneCore = sampleWindowMs > 0
    ? finiteNonNegative((usedMicroseconds / (sampleWindowMs * 1_000)) * 100)
    : 0;

  return {
    sampleWindowMs,
    userMicroseconds: finiteNonNegative(current.process.user),
    systemMicroseconds: finiteNonNegative(current.process.system),
    percentOfOneCore,
    percentOfMachineCapacity: boundedPercent(percentOfOneCore / count),
    logicalCpuCount: count,
  };
}

function cpuTimesTotal(value: CpuTimes): number {
  return value.user + value.nice + value.sys + value.idle + value.irq;
}

function systemCpuSnapshot(
  previous: RuntimeCpuSample,
  current: RuntimeCpuSample,
  sampleWindowMs: number,
) {
  const count = logicalCpuCount(current.system);
  let busyDeltaMs = 0;
  let totalDeltaMs = 0;

  // CPU topology may change at runtime. Comparing mismatched arrays would turn
  // cumulative boot-time counters into a false spike, so begin a fresh sample.
  if (previous.system.length === current.system.length && current.system.length > 0) {
    for (let index = 0; index < current.system.length; index += 1) {
      const before = previous.system[index];
      const after = current.system[index];
      const totalDelta = Math.max(0, cpuTimesTotal(after) - cpuTimesTotal(before));
      const idleDelta = Math.max(0, after.idle - before.idle);
      totalDeltaMs += totalDelta;
      busyDeltaMs += Math.max(0, totalDelta - Math.min(totalDelta, idleDelta));
    }
  }

  const percentOfOneCore = sampleWindowMs > 0
    ? finiteNonNegative((busyDeltaMs / sampleWindowMs) * 100)
    : 0;
  const percentOfMachineCapacity = totalDeltaMs > 0
    ? boundedPercent((busyDeltaMs / totalDeltaMs) * 100)
    : 0;

  return {
    sampleWindowMs,
    percentOfOneCore,
    percentOfMachineCapacity,
    logicalCpuCount: count,
  };
}

const CGROUP_V2_ROOT = '/sys/fs/cgroup';

function currentCgroupV2Directory(): string | null {
  let membership: string;
  try {
    membership = readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return null;
  }

  const unifiedPaths = membership
    .split(/\r?\n/)
    .map((line) => line.match(/^0::(\/[^\0\r\n]*)$/)?.[1])
    .filter((value): value is string => value !== undefined);
  if (unifiedPaths.length !== 1) return null;

  // Prefix the absolute kernel path with a dot so resolve() treats it as
  // relative to the known cgroup2 mount. The relative() check is a second,
  // explicit guard against malformed membership containing traversal.
  const directory = resolve(CGROUP_V2_ROOT, `.${unifiedPaths[0]}`);
  const relativeDirectory = relative(CGROUP_V2_ROOT, directory);
  if (
    relativeDirectory === '..' ||
    relativeDirectory.startsWith(`..${sep}`) ||
    isAbsolute(relativeDirectory)
  ) {
    return null;
  }
  return directory;
}

function readCgroupFile(directory: string, name: string): string | null {
  try {
    const value = readFileSync(resolve(directory, name), 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

function nonNegativeInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function cgroupCpuUsage(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/(?:^|\n)usage_usec\s+(\d+)(?:\n|$)/);
  return nonNegativeInteger(match?.[1] ?? null);
}

function cgroupCpuLimit(value: string | null): {
  quotaMicroseconds: number | null;
  periodMicroseconds: number | null;
  quotaCpuCount: number | null;
  unlimited: boolean | null;
} {
  const parts = value?.split(/\s+/) ?? [];
  if (parts.length !== 2) {
    return {
      quotaMicroseconds: null,
      periodMicroseconds: null,
      quotaCpuCount: null,
      unlimited: null,
    };
  }
  const periodMicroseconds = nonNegativeInteger(parts[1]);
  if (!periodMicroseconds || periodMicroseconds <= 0) {
    return {
      quotaMicroseconds: null,
      periodMicroseconds: null,
      quotaCpuCount: null,
      unlimited: null,
    };
  }
  if (parts[0] === 'max') {
    return {
      quotaMicroseconds: null,
      periodMicroseconds,
      quotaCpuCount: null,
      unlimited: true,
    };
  }
  const quotaMicroseconds = nonNegativeInteger(parts[0]);
  if (quotaMicroseconds === null) {
    return {
      quotaMicroseconds: null,
      periodMicroseconds,
      quotaCpuCount: null,
      unlimited: null,
    };
  }
  return {
    quotaMicroseconds,
    periodMicroseconds,
    quotaCpuCount: finiteNonNegative(quotaMicroseconds / periodMicroseconds),
    unlimited: false,
  };
}

function cgroupV2Snapshot() {
  const directory = currentCgroupV2Directory();
  if (!directory) return { available: false as const };

  const memoryCurrent = nonNegativeInteger(readCgroupFile(directory, 'memory.current'));
  const rawMemoryMax = readCgroupFile(directory, 'memory.max');
  const memoryUnlimited = rawMemoryMax === 'max';
  const memoryMax = memoryUnlimited ? null : nonNegativeInteger(rawMemoryMax);
  const memoryMaxAvailable = memoryUnlimited || memoryMax !== null;
  const cpuUsageMicroseconds = cgroupCpuUsage(readCgroupFile(directory, 'cpu.stat'));
  const cpuLimit = cgroupCpuLimit(readCgroupFile(directory, 'cpu.max'));
  const available = memoryCurrent !== null || memoryMaxAvailable ||
    cpuUsageMicroseconds !== null || cpuLimit.periodMicroseconds !== null;

  if (!available) return { available: false as const };
  return {
    available: true as const,
    memoryBytes: {
      current: memoryCurrent,
      max: memoryMax,
      unlimited: memoryMaxAvailable ? memoryUnlimited : null,
    },
    cpu: {
      usageMicroseconds: cpuUsageMicroseconds,
      ...cpuLimit,
    },
  };
}

function systemMemorySnapshot() {
  const total = finiteNonNegative(totalmem());
  const free = Math.min(total, finiteNonNegative(freemem()));
  return { total, free, used: Math.max(0, total - free) };
}

function loadAverageSnapshot() {
  const values = loadavg();
  return {
    oneMinute: finiteNonNegative(values[0] ?? 0),
    fiveMinutes: finiteNonNegative(values[1] ?? 0),
    fifteenMinutes: finiteNonNegative(values[2] ?? 0),
  };
}

export class RuntimeMetrics {
  readonly startedAt = new Date().toISOString();
  private readonly startedAtMs = Date.now();
  private cpuSample = captureRuntimeCpuSample();
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
  private readonly liveDraft = {
    reads: 0,
    updateRequests: 0,
    fieldsUpdated: 0,
    updateReplays: 0,
    locksAcquired: 0,
    locksRenewed: 0,
    locksReleased: 0,
    lockConflicts: 0,
    commits: 0,
    commitConflicts: 0,
    discards: 0,
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

  recordLiveDraftRead(): void {
    this.liveDraft.reads += 1;
  }

  recordLiveDraftUpdate(fieldCount: number, replayed: boolean): void {
    this.liveDraft.updateRequests += 1;
    if (replayed) this.liveDraft.updateReplays += 1;
    else this.liveDraft.fieldsUpdated += fieldCount;
  }

  recordLiveDraftLock(action: 'acquired' | 'renewed' | 'released' | 'conflict'): void {
    if (action === 'acquired') this.liveDraft.locksAcquired += 1;
    else if (action === 'renewed') this.liveDraft.locksRenewed += 1;
    else if (action === 'released') this.liveDraft.locksReleased += 1;
    else this.liveDraft.lockConflicts += 1;
  }

  recordLiveDraftCommit(conflict: boolean): void {
    if (conflict) this.liveDraft.commitConflicts += 1;
    else this.liveDraft.commits += 1;
  }

  recordLiveDraftDiscard(): void {
    this.liveDraft.discards += 1;
  }

  snapshot() {
    const memory = process.memoryUsage();
    const currentCpuSample = captureRuntimeCpuSample();
    const previousCpuSample = this.cpuSample;
    this.cpuSample = currentCpuSample;
    const sampleWindowMs = elapsedMilliseconds(
      previousCpuSample.capturedAt,
      currentCpuSample.capturedAt,
    );
    const processCpu = processCpuSnapshot(
      previousCpuSample,
      currentCpuSample,
      sampleWindowMs,
    );
    const systemCpu = systemCpuSnapshot(
      previousCpuSample,
      currentCpuSample,
      sampleWindowMs,
    );
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
        cpu: processCpu,
      },
      system: {
        scope: 'node-visible-runtime' as const,
        logicalCpuCount: systemCpu.logicalCpuCount,
        cpu: systemCpu,
        memoryBytes: systemMemorySnapshot(),
        loadAverage: loadAverageSnapshot(),
        cgroupV2: cgroupV2Snapshot(),
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
      liveDraft: { ...this.liveDraft },
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
