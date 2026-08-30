import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

export const LIVE_DRAFT_HISTORY_PREVIEW_TTL_MS = 20_000;

export const LIVE_DRAFT_HISTORY_REUSE_FIELDS = [
  'qth',
  'device',
  'power',
  'antenna',
  'height',
] as const;

export type LiveDraftHistoryReuseField =
  (typeof LIVE_DRAFT_HISTORY_REUSE_FIELDS)[number];

export interface LiveDraftHistoryCandidate {
  readonly candidateId: string;
  readonly sourceTime: string;
  readonly qth: string | null;
  readonly device: string | null;
  readonly power: string | null;
  readonly antenna: string | null;
  readonly height: string | null;
}

export interface LiveDraftHistoryPreview {
  readonly previewId: string;
  readonly draftId: string;
  readonly deviceId: string;
  readonly callsign: string;
  readonly actor: {
    readonly userId: string;
    readonly username: string;
  };
  readonly expiresAt: string;
  readonly candidates: readonly LiveDraftHistoryCandidate[];
}

export class LiveDraftHistoryPreviewManager {
  private readonly previews = new Map<string, LiveDraftHistoryPreview>();

  get(
    sessionId: string,
    now = Date.now(),
  ): LiveDraftHistoryPreview | undefined {
    const preview = this.previews.get(sessionId);
    if (!preview) return undefined;
    if (Date.parse(preview.expiresAt) <= now) {
      this.previews.delete(sessionId);
      return undefined;
    }
    return preview;
  }

  publish(input: {
    sessionId: string;
    draftId: string;
    deviceId: string;
    callsign: string;
    actor: { userId: string; username: string };
    candidates: readonly LiveDraftHistoryCandidate[];
    now?: number;
  }): LiveDraftHistoryPreview {
    const now = input.now ?? Date.now();
    const preview: LiveDraftHistoryPreview = Object.freeze({
      previewId: randomUUID(),
      draftId: input.draftId,
      deviceId: input.deviceId,
      callsign: input.callsign,
      actor: Object.freeze({ ...input.actor }),
      expiresAt: new Date(now + LIVE_DRAFT_HISTORY_PREVIEW_TTL_MS).toISOString(),
      candidates: Object.freeze(
        input.candidates.map((candidate) => Object.freeze({ ...candidate })),
      ),
    });
    this.previews.set(input.sessionId, preview);
    return preview;
  }

  clear(
    sessionId: string,
    previewId?: string,
    now = Date.now(),
  ): LiveDraftHistoryPreview | undefined {
    const preview = this.get(sessionId, now);
    if (!preview || (previewId !== undefined && preview.previewId !== previewId)) {
      return undefined;
    }
    this.previews.delete(sessionId);
    return preview;
  }
}

const managers = new WeakMap<
  Database.Database,
  LiveDraftHistoryPreviewManager
>();

export function getLiveDraftHistoryPreviewManager(
  db: Database.Database,
): LiveDraftHistoryPreviewManager {
  let manager = managers.get(db);
  if (!manager) {
    manager = new LiveDraftHistoryPreviewManager();
    managers.set(db, manager);
  }
  return manager;
}
