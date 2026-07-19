export type AccountRole = 'admin' | 'user';
export type SessionRole = 'owner' | 'editor' | 'viewer';
export type SessionStatus = 'initializing' | 'active' | 'closed' | 'deleted';

export interface User {
  id: string;
  username: string;
  role: AccountRole;
  createdAt?: string;
  disabledAt?: string | null;
  mustChangePassword?: boolean;
  loginNeverExpires?: boolean;
}

export interface AuthSession {
  accessToken: string;
  accessTokenExpiresIn?: number;
  user: User;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  status: SessionStatus;
  version: number;
  role: SessionRole;
  highWatermarkSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  deletedAt: string | null;
  ownerUsername?: string;
  logCount?: number;
}

export interface LogRecord {
  syncId: string;
  sessionId: string;
  version: number;
  time: string;
  controller: string;
  callsign: string;
  rstSent: string | null;
  rstRcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: string | null;
  ownedByCurrentUser?: boolean;
  canMutate?: boolean;
}

export interface SessionSnapshot {
  protocolVersion: number;
  session: SessionSummary;
  highWatermarkSeq: number;
  includesDeletedLogs: boolean;
  logs: LogRecord[];
}

export interface Member {
  membershipId: string;
  sessionId: string;
  userId: string;
  username: string;
  role: SessionRole;
  version: number;
  joinedAt: string;
  updatedAt: string;
  removedAt: string | null;
}

export interface Invite {
  inviteId: string;
  sessionId: string;
  codeHint: string;
  code?: string;
  linkToken?: string;
  role: Exclude<SessionRole, 'owner'>;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface PublicShare {
  publicShareId: string;
  sessionId: string;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  secret?: string;
}

export interface AuditEvent {
  auditEventId: string;
  action: string;
  actorUserId: string;
  targetUserId?: string | null;
  targetSessionId?: string | null;
  targetLogId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  sessionId?: string | null;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  requestId: string | null;
  mutationId: string | null;
  occurredAt: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CursorPage<T> {
  items: T[];
  pageInfo: { limit: number; hasMore: boolean; nextCursor: string | null };
}

export interface AdminOverview {
  serverInstanceId: string;
  generatedAt: string;
  registrationEnabled: boolean;
  counts: {
    users: { total: number; admins: number };
    sessions: { total: number; initializing: number; active: number; closed: number; deleted: number };
  };
}

export interface ServerInfo {
  serverInstanceId?: string;
  version?: string;
  protocolVersion?: number;
  registrationEnabled?: boolean;
  capabilities?: Record<string, boolean>;
}

export interface PersonalSnapshotMetadata {
  exists: boolean;
  revision: number;
  formatVersion: number;
  sessionCount: number;
  logCount: number;
  byteSize: number;
  checksum: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PersonalSnapshotSession {
  session_id: string;
  title: string;
  status: 'active' | 'closed' | 'archived';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deleted_at: string | null;
}

export interface PersonalSnapshotLog {
  sync_id: string;
  session_id: string;
  time: string;
  controller: string;
  callsign: string;
  rst_sent: string | null;
  rst_rcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  source_device_id: string | null;
}

export interface PersonalSnapshot {
  version: 1;
  exportedAt: string;
  sessions: PersonalSnapshotSession[];
  logs: PersonalSnapshotLog[];
}

export interface PersonalSnapshotDownload extends PersonalSnapshotMetadata {
  snapshot: PersonalSnapshot;
}

export interface PersonalSnapshotOwner {
  id: string;
  username: string;
}

export interface AdminPersonalSnapshotItem {
  user: PersonalSnapshotOwner;
  personalSnapshot: PersonalSnapshotMetadata;
}

export interface AdminPersonalSnapshotDetail {
  user: PersonalSnapshotOwner;
  personalSnapshot: PersonalSnapshotDownload;
}

export interface PersonalDictionarySnapshotMetadata {
  exists: boolean;
  revision: number;
  formatVersion: number;
  itemCount: number;
  activeCount: number;
  deletedCount: number;
  byteSize: number;
  checksum: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export type PersonalDictionaryType = 'device' | 'antenna' | 'callsign' | 'qth';
export type PersonalDictionaryOrigin = 'user' | 'builtin';
export type PersonalDictionaryItemState = 'active' | 'deleted';

export interface PersonalDictionarySnapshotItem {
  dictType: PersonalDictionaryType;
  raw: string;
  origin: PersonalDictionaryOrigin;
  state: PersonalDictionaryItemState;
  pinyin: string | null;
  abbreviation: string | null;
}

export interface PersonalDictionarySnapshot {
  version: 1;
  exportedAt: string;
  items: PersonalDictionarySnapshotItem[];
}

export interface PersonalDictionarySnapshotDownload
  extends PersonalDictionarySnapshotMetadata {
  snapshot: PersonalDictionarySnapshot;
}

export interface AdminPersonalDictionarySnapshotItem {
  user: PersonalSnapshotOwner;
  personalDictionarySnapshot: PersonalDictionarySnapshotMetadata;
}

export interface AdminPersonalDictionarySnapshotDetail {
  user: PersonalSnapshotOwner;
  personalDictionarySnapshot: PersonalDictionarySnapshotDownload;
}

export type ThemeMode = 'system' | 'light' | 'dark';
export type Locale = 'zh-CN' | 'en-US';
