import { createHash, randomUUID } from 'crypto';
import Database from 'better-sqlite3';

type SqliteRow = Record<string, unknown>;

interface Migration {
  version: number;
  name: string;
  checksum: string;
  up: (db: Database.Database) => void;
}

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

const SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registration_enabled INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO server_settings (id, registration_enabled) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  controller TEXT NOT NULL,
  callsign TEXT NOT NULL,
  time TEXT NOT NULL,
  rst_sent TEXT,
  rst_rcvd TEXT,
  qth TEXT,
  device TEXT,
  power TEXT,
  antenna TEXT,
  height TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id);
CREATE INDEX IF NOT EXISTS idx_logs_sync_id ON logs(sync_id);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_user_id);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  code TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_shares_code ON shares(code);
CREATE INDEX IF NOT EXISTS idx_shares_session ON shares(session_id);
`;

const OPERATIONAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS migration_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_version INTEGER NOT NULL,
  action TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT,
  old_key TEXT,
  new_key TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_migration_audit_version
ON migration_audit(migration_version, id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  rotated_at TEXT,
  replaced_by_id TEXT REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  last_used_at TEXT,
  user_agent TEXT,
  ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active
ON refresh_tokens(user_id, expires_at)
WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_device
ON refresh_tokens(user_id, device_id)
WHERE device_id IS NOT NULL;
`;

const COLLABORATION_FOUNDATION_SQL = `
DROP INDEX IF EXISTS idx_logs_sync_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_logs_session_sync_id
ON logs(session_id, sync_id);

CREATE INDEX IF NOT EXISTS idx_logs_session_deleted_time
ON logs(session_id, deleted_at, time);

CREATE INDEX IF NOT EXISTS idx_sessions_status_deleted
ON sessions(status, deleted_at);
`;

const COLLABORATION_ACCESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_members (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  removed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (session_id, user_id),
  CHECK (removed_at IS NOT NULL OR removed_by IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_session_members_user_active
ON session_members(user_id, session_id)
WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_session_members_session_active
ON session_members(session_id, role, user_id)
WHERE removed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_session_members_active_owner
ON session_members(session_id)
WHERE role = 'owner' AND removed_at IS NULL;

CREATE TABLE IF NOT EXISTS collaboration_invites (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) > 0),
  link_token_hash TEXT UNIQUE,
  code_hint TEXT NOT NULL CHECK (length(code_hint) > 0),
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0
    CHECK (used_count >= 0 AND used_count <= max_uses),
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (revoked_at IS NOT NULL OR revoked_by IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_invites_session_active
ON collaboration_invites(session_id, created_at DESC)
WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_collaboration_invites_expiry
ON collaboration_invites(expires_at)
WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS invite_redemptions (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES collaboration_invites(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  membership_id TEXT REFERENCES session_members(id) ON DELETE SET NULL,
  join_request_id TEXT NOT NULL UNIQUE,
  device_id TEXT,
  role_granted TEXT NOT NULL CHECK (role_granted IN ('editor', 'viewer')),
  redeemed_at TEXT NOT NULL,
  UNIQUE (invite_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_invite_redemptions_user
ON invite_redemptions(user_id, redeemed_at);

CREATE TABLE IF NOT EXISTS processed_mutations (
  mutation_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  device_id TEXT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) > 0),
  status_code INTEGER NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_mutations_session_created
ON processed_mutations(session_id, created_at)
WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_processed_mutations_user_created
ON processed_mutations(user_id, created_at);
`;

const DISABLE_LEGACY_SHARES_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_legacy_shares_require_revoked_insert
BEFORE INSERT ON shares
WHEN NEW.revoked_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'legacy shares are disabled');
END;

CREATE TRIGGER IF NOT EXISTS trg_legacy_shares_require_revoked_update
BEFORE UPDATE OF revoked_at ON shares
WHEN NEW.revoked_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'legacy shares are disabled');
END;
`;

const COLLABORATION_REALTIME_SQL = `
CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  type TEXT NOT NULL CHECK (type IN (
    'session.activated', 'session.updated', 'session.closed',
    'session.reopened', 'session.deleted', 'log.created',
    'log.updated', 'log.deleted', 'log.restored'
  )),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('session', 'log')),
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version > 0),
  mutation_id TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_device_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX idx_session_events_after
ON session_events(session_id, seq);

CREATE UNIQUE INDEX uq_session_events_mutation
ON session_events(mutation_id)
WHERE mutation_id IS NOT NULL;

CREATE TABLE ws_tickets (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_role TEXT NOT NULL CHECK (issued_role IN ('owner', 'editor', 'viewer')),
  issued_membership_version INTEGER NOT NULL CHECK (issued_membership_version >= 1),
  device_id TEXT NOT NULL,
  after_seq INTEGER NOT NULL CHECK (after_seq >= 0),
  issued_ip TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX idx_ws_tickets_expiry
ON ws_tickets(expires_at)
WHERE consumed_at IS NULL;

CREATE INDEX idx_ws_tickets_user_session
ON ws_tickets(user_id, session_id, created_at DESC);
`;

const RUNTIME_ADMIN_AUDIT_SQL = `
CREATE TABLE admin_audit_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (action IN (
    'settings.registration.updated',
    'user.role.updated',
    'user.refresh_tokens.revoked'
  )),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  mutation_id TEXT NOT NULL UNIQUE CHECK (length(mutation_id) BETWEEN 1 AND 128),
  before_json TEXT CHECK (
    before_json IS NULL OR
    (json_valid(before_json) AND json_type(before_json) = 'object')
  ),
  after_json TEXT CHECK (
    after_json IS NULL OR
    (json_valid(after_json) AND json_type(after_json) = 'object')
  ),
  details_json TEXT NOT NULL CHECK (
    json_valid(details_json) AND json_type(details_json) = 'object'
  ),
  occurred_at TEXT NOT NULL,
  CHECK (
    (action = 'settings.registration.updated' AND target_user_id IS NULL) OR
    (
      action IN ('user.role.updated', 'user.refresh_tokens.revoked') AND
      target_user_id IS NOT NULL
    )
  )
);

CREATE INDEX idx_admin_audit_events_occurred
ON admin_audit_events(occurred_at DESC, id DESC);

CREATE INDEX idx_admin_audit_events_action_occurred
ON admin_audit_events(action, occurred_at DESC, id DESC);

CREATE INDEX idx_admin_audit_events_actor_occurred
ON admin_audit_events(actor_user_id, occurred_at DESC, id DESC);

CREATE INDEX idx_admin_audit_events_target_occurred
ON admin_audit_events(target_user_id, occurred_at DESC, id DESC)
WHERE target_user_id IS NOT NULL;

CREATE TRIGGER trg_users_role_valid_insert
BEFORE INSERT ON users
WHEN NEW.role NOT IN ('admin', 'user')
BEGIN
  SELECT RAISE(ABORT, 'users.role must be admin or user');
END;

CREATE TRIGGER trg_users_role_valid_update
BEFORE UPDATE OF role ON users
WHEN NEW.role NOT IN ('admin', 'user')
BEGIN
  SELECT RAISE(ABORT, 'users.role must be admin or user');
END;

CREATE TRIGGER trg_users_last_admin_update
BEFORE UPDATE OF role ON users
WHEN
  OLD.role = 'admin' AND
  NEW.role <> 'admin' AND
  (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1
BEGIN
  SELECT RAISE(ABORT, 'at least one administrator is required');
END;

CREATE TRIGGER trg_users_last_admin_delete
BEFORE DELETE ON users
WHEN
  OLD.role = 'admin' AND
  (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1
BEGIN
  SELECT RAISE(ABORT, 'at least one administrator is required');
END;

CREATE TRIGGER trg_admin_audit_events_append_only_update
BEFORE UPDATE ON admin_audit_events
BEGIN
  SELECT RAISE(ABORT, 'administrator audit events are append-only');
END;

CREATE TRIGGER trg_admin_audit_events_append_only_delete
BEFORE DELETE ON admin_audit_events
BEGIN
  SELECT RAISE(ABORT, 'administrator audit events are append-only');
END;
`;

const COLLABORATION_AUDIT_SQL = `
CREATE TABLE collaboration_audit_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN (
    'membership.role.updated',
    'membership.removed',
    'ownership.transferred',
    'invite.created',
    'invite.redeemed',
    'invite.revoked',
    'session.deleted'
  )),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  before_json TEXT CHECK (
    before_json IS NULL OR
    (json_valid(before_json) AND json_type(before_json) = 'object')
  ),
  after_json TEXT CHECK (
    after_json IS NULL OR
    (json_valid(after_json) AND json_type(after_json) = 'object')
  ),
  details_json TEXT NOT NULL CHECK (
    json_valid(details_json) AND json_type(details_json) = 'object'
  ),
  occurred_at TEXT NOT NULL,
  UNIQUE (session_id, action, mutation_id),
  CHECK (
    (
      action IN (
        'membership.role.updated',
        'membership.removed',
        'ownership.transferred',
        'invite.redeemed'
      ) AND target_user_id IS NOT NULL
    ) OR (
      action IN ('invite.created', 'invite.revoked', 'session.deleted')
      AND target_user_id IS NULL
    )
  ),
  CHECK (
    (action = 'invite.created' AND before_json IS NULL) OR
    (action <> 'invite.created' AND before_json IS NOT NULL)
  ),
  CHECK (after_json IS NOT NULL)
);

CREATE INDEX idx_collaboration_audit_session_occurred
ON collaboration_audit_events(session_id, occurred_at DESC, id DESC);

CREATE INDEX idx_collaboration_audit_session_action_occurred
ON collaboration_audit_events(session_id, action, occurred_at DESC, id DESC);

CREATE INDEX idx_collaboration_audit_session_actor_occurred
ON collaboration_audit_events(session_id, actor_user_id, occurred_at DESC, id DESC);

CREATE INDEX idx_collaboration_audit_session_target_occurred
ON collaboration_audit_events(session_id, target_user_id, occurred_at DESC, id DESC)
WHERE target_user_id IS NOT NULL;

CREATE TRIGGER trg_collaboration_audit_append_only_replace
BEFORE INSERT ON collaboration_audit_events
WHEN EXISTS (
  SELECT 1 FROM collaboration_audit_events
  WHERE id = NEW.id OR (
    session_id = NEW.session_id AND
    action = NEW.action AND
    mutation_id = NEW.mutation_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'collaboration audit events are append-only');
END;

CREATE TRIGGER trg_collaboration_audit_append_only_update
BEFORE UPDATE ON collaboration_audit_events
BEGIN
  SELECT RAISE(ABORT, 'collaboration audit events are append-only');
END;

CREATE TRIGGER trg_collaboration_audit_append_only_delete
BEFORE DELETE ON collaboration_audit_events
BEGIN
  SELECT RAISE(ABORT, 'collaboration audit events are append-only');
END;
`;

const PUBLIC_LIVESHARE_CAPABILITIES_SQL = `
CREATE TABLE public_shares (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version = 1),
  secret_hash TEXT NOT NULL UNIQUE CHECK (
    length(secret_hash) = 64 AND
    secret_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 64),
  expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 20 AND 64),
  revoked_at TEXT CHECK (
    revoked_at IS NULL OR length(revoked_at) BETWEEN 20 AND 64
  ),
  revoked_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);

CREATE INDEX idx_public_shares_session_created
ON public_shares(session_id, created_at DESC, id DESC);

CREATE INDEX idx_public_shares_session_active
ON public_shares(session_id, expires_at, id)
WHERE revoked_at IS NULL;

CREATE INDEX idx_public_shares_active_expiry
ON public_shares(expires_at, id)
WHERE revoked_at IS NULL;

CREATE TRIGGER trg_public_shares_active_session_insert
BEFORE INSERT ON public_shares
WHEN NOT EXISTS (
  SELECT 1
  FROM sessions
  WHERE id = NEW.session_id
    AND deleted_at IS NULL
    AND status IN ('active', 'closed')
)
BEGIN
  SELECT RAISE(ABORT, 'public shares require an active or closed Session');
END;

CREATE TRIGGER trg_public_shares_prevent_replace
BEFORE INSERT ON public_shares
WHEN EXISTS (
  SELECT 1
  FROM public_shares
  WHERE id = NEW.id OR secret_hash = NEW.secret_hash
)
BEGIN
  SELECT RAISE(ABORT, 'public shares cannot replace existing capabilities');
END;

CREATE TRIGGER trg_public_shares_revoke_only
BEFORE UPDATE ON public_shares
WHEN
  OLD.revoked_at IS NOT NULL OR
  NEW.revoked_at IS NULL OR
  NEW.revoked_by IS NULL OR
  NEW.id IS NOT OLD.id OR
  NEW.session_id IS NOT OLD.session_id OR
  NEW.credential_version IS NOT OLD.credential_version OR
  NEW.secret_hash IS NOT OLD.secret_hash OR
  NEW.created_by IS NOT OLD.created_by OR
  NEW.created_at IS NOT OLD.created_at OR
  NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'public shares are immutable except for one-way revocation');
END;

CREATE TRIGGER trg_public_shares_prevent_delete
BEFORE DELETE ON public_shares
BEGIN
  SELECT RAISE(ABORT, 'public shares must be retained as revoked capabilities');
END;

CREATE TABLE public_ws_tickets (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND
    token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  public_share_id TEXT NOT NULL REFERENCES public_shares(id) ON DELETE CASCADE,
  access_token_id TEXT NOT NULL CHECK (length(access_token_id) BETWEEN 1 AND 128),
  after_seq INTEGER NOT NULL CHECK (after_seq >= 0),
  issued_ip TEXT CHECK (issued_ip IS NULL OR length(issued_ip) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 64),
  expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 20 AND 64),
  authorization_expires_at TEXT NOT NULL CHECK (
    length(authorization_expires_at) BETWEEN 20 AND 64
  ),
  consumed_at TEXT CHECK (
    consumed_at IS NULL OR length(consumed_at) BETWEEN 20 AND 64
  ),
  CHECK (expires_at > created_at),
  CHECK (authorization_expires_at >= expires_at),
  CHECK (
    consumed_at IS NULL OR
    (consumed_at >= created_at AND consumed_at <= expires_at)
  )
);

CREATE INDEX idx_public_ws_tickets_expiry
ON public_ws_tickets(expires_at, id)
WHERE consumed_at IS NULL;

CREATE INDEX idx_public_ws_tickets_share_created
ON public_ws_tickets(public_share_id, created_at DESC, id DESC);

CREATE INDEX idx_public_ws_tickets_share_pending
ON public_ws_tickets(public_share_id, expires_at, id)
WHERE consumed_at IS NULL;

CREATE INDEX idx_public_ws_tickets_access_token_pending
ON public_ws_tickets(access_token_id, expires_at, id)
WHERE consumed_at IS NULL;

CREATE INDEX idx_public_ws_tickets_consumed
ON public_ws_tickets(consumed_at, id)
WHERE consumed_at IS NOT NULL;

CREATE TRIGGER trg_public_ws_tickets_active_share_insert
BEFORE INSERT ON public_ws_tickets
WHEN NOT EXISTS (
  SELECT 1
  FROM public_shares ps
  JOIN sessions s ON s.id = ps.session_id
  WHERE ps.id = NEW.public_share_id
    AND ps.revoked_at IS NULL
    AND ps.expires_at > NEW.created_at
    AND NEW.authorization_expires_at <= ps.expires_at
    AND s.deleted_at IS NULL
    AND s.status IN ('active', 'closed')
)
BEGIN
  SELECT RAISE(ABORT, 'public WebSocket tickets require an active public share');
END;

CREATE TRIGGER trg_public_ws_tickets_prevent_replace
BEFORE INSERT ON public_ws_tickets
WHEN EXISTS (
  SELECT 1
  FROM public_ws_tickets
  WHERE id = NEW.id OR token_hash = NEW.token_hash
)
BEGIN
  SELECT RAISE(ABORT, 'public WebSocket tickets cannot replace existing tickets');
END;

CREATE TRIGGER trg_public_ws_tickets_consume_only
BEFORE UPDATE ON public_ws_tickets
WHEN
  OLD.consumed_at IS NOT NULL OR
  NEW.consumed_at IS NULL OR
  NEW.expires_at <= NEW.consumed_at OR
  NEW.authorization_expires_at <= NEW.consumed_at OR
  NEW.id IS NOT OLD.id OR
  NEW.token_hash IS NOT OLD.token_hash OR
  NEW.public_share_id IS NOT OLD.public_share_id OR
  NEW.access_token_id IS NOT OLD.access_token_id OR
  NEW.after_seq IS NOT OLD.after_seq OR
  NEW.issued_ip IS NOT OLD.issued_ip OR
  NEW.created_at IS NOT OLD.created_at OR
  NEW.expires_at IS NOT OLD.expires_at OR
  NEW.authorization_expires_at IS NOT OLD.authorization_expires_at OR
  NOT EXISTS (
    SELECT 1
    FROM public_shares ps
    JOIN sessions s ON s.id = ps.session_id
    WHERE ps.id = OLD.public_share_id
      AND ps.revoked_at IS NULL
      AND ps.expires_at > NEW.consumed_at
      AND s.deleted_at IS NULL
      AND s.status IN ('active', 'closed')
  )
BEGIN
  SELECT RAISE(ABORT, 'public WebSocket tickets may only be consumed once while authorized');
END;

CREATE TABLE collaboration_audit_events_v11 (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN (
    'membership.role.updated',
    'membership.removed',
    'ownership.transferred',
    'invite.created',
    'invite.redeemed',
    'invite.revoked',
    'session.deleted',
    'public_share.created',
    'public_share.revoked'
  )),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  before_json TEXT CHECK (
    before_json IS NULL OR
    (json_valid(before_json) AND json_type(before_json) = 'object')
  ),
  after_json TEXT CHECK (
    after_json IS NULL OR
    (json_valid(after_json) AND json_type(after_json) = 'object')
  ),
  details_json TEXT NOT NULL CHECK (
    json_valid(details_json) AND json_type(details_json) = 'object'
  ),
  occurred_at TEXT NOT NULL,
  UNIQUE (session_id, action, mutation_id),
  CHECK (
    (
      action IN (
        'membership.role.updated',
        'membership.removed',
        'ownership.transferred',
        'invite.redeemed'
      ) AND target_user_id IS NOT NULL
    ) OR (
      action IN (
        'invite.created',
        'invite.revoked',
        'session.deleted',
        'public_share.created',
        'public_share.revoked'
      ) AND target_user_id IS NULL
    )
  ),
  CHECK (
    (
      action IN ('invite.created', 'public_share.created') AND
      before_json IS NULL
    ) OR (
      action NOT IN ('invite.created', 'public_share.created') AND
      before_json IS NOT NULL
    )
  ),
  CHECK (after_json IS NOT NULL)
);

INSERT INTO collaboration_audit_events_v11 (
  id, session_id, action, actor_user_id, target_user_id,
  request_id, mutation_id, before_json, after_json, details_json, occurred_at
)
SELECT
  id, session_id, action, actor_user_id, target_user_id,
  request_id, mutation_id, before_json, after_json, details_json, occurred_at
FROM collaboration_audit_events;

DROP TABLE collaboration_audit_events;
ALTER TABLE collaboration_audit_events_v11 RENAME TO collaboration_audit_events;

CREATE INDEX idx_collaboration_audit_session_occurred
ON collaboration_audit_events(session_id, occurred_at DESC, id DESC);

CREATE INDEX idx_collaboration_audit_session_action_occurred
ON collaboration_audit_events(session_id, action, occurred_at DESC, id DESC);

CREATE INDEX idx_collaboration_audit_session_actor_occurred
ON collaboration_audit_events(session_id, actor_user_id, occurred_at DESC, id DESC);

CREATE INDEX idx_collaboration_audit_session_target_occurred
ON collaboration_audit_events(session_id, target_user_id, occurred_at DESC, id DESC)
WHERE target_user_id IS NOT NULL;

CREATE TRIGGER trg_collaboration_audit_append_only_replace
BEFORE INSERT ON collaboration_audit_events
WHEN EXISTS (
  SELECT 1 FROM collaboration_audit_events
  WHERE id = NEW.id OR (
    session_id = NEW.session_id AND
    action = NEW.action AND
    mutation_id = NEW.mutation_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'collaboration audit events are append-only');
END;

CREATE TRIGGER trg_collaboration_audit_append_only_update
BEFORE UPDATE ON collaboration_audit_events
BEGIN
  SELECT RAISE(ABORT, 'collaboration audit events are append-only');
END;

CREATE TRIGGER trg_collaboration_audit_append_only_delete
BEFORE DELETE ON collaboration_audit_events
BEGIN
  SELECT RAISE(ABORT, 'collaboration audit events are append-only');
END;
`;

const SESSION_EVENT_RETENTION_SQL = `
CREATE TABLE admin_audit_events_v12 (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (action IN (
    'settings.registration.updated',
    'user.role.updated',
    'user.refresh_tokens.revoked',
    'session_events.pruned'
  )),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  mutation_id TEXT NOT NULL UNIQUE CHECK (length(mutation_id) BETWEEN 1 AND 128),
  before_json TEXT CHECK (
    before_json IS NULL OR
    (json_valid(before_json) AND json_type(before_json) = 'object')
  ),
  after_json TEXT CHECK (
    after_json IS NULL OR
    (json_valid(after_json) AND json_type(after_json) = 'object')
  ),
  details_json TEXT NOT NULL CHECK (
    json_valid(details_json) AND json_type(details_json) = 'object'
  ),
  occurred_at TEXT NOT NULL,
  CHECK (
    (
      action IN ('settings.registration.updated', 'session_events.pruned') AND
      target_user_id IS NULL
    ) OR (
      action IN ('user.role.updated', 'user.refresh_tokens.revoked') AND
      target_user_id IS NOT NULL
    )
  )
);

INSERT INTO admin_audit_events_v12 (
  id, action, actor_user_id, target_user_id, request_id, mutation_id,
  before_json, after_json, details_json, occurred_at
)
SELECT
  id, action, actor_user_id, target_user_id, request_id, mutation_id,
  before_json, after_json, details_json, occurred_at
FROM admin_audit_events;

DROP TABLE admin_audit_events;
ALTER TABLE admin_audit_events_v12 RENAME TO admin_audit_events;

CREATE INDEX idx_admin_audit_events_occurred
ON admin_audit_events(occurred_at DESC, id DESC);

CREATE INDEX idx_admin_audit_events_action_occurred
ON admin_audit_events(action, occurred_at DESC, id DESC);

CREATE INDEX idx_admin_audit_events_actor_occurred
ON admin_audit_events(actor_user_id, occurred_at DESC, id DESC);

CREATE INDEX idx_admin_audit_events_target_occurred
ON admin_audit_events(target_user_id, occurred_at DESC, id DESC)
WHERE target_user_id IS NOT NULL;

CREATE TRIGGER trg_admin_audit_events_append_only_replace
BEFORE INSERT ON admin_audit_events
WHEN EXISTS (
  SELECT 1 FROM admin_audit_events
  WHERE id = NEW.id OR mutation_id = NEW.mutation_id
)
BEGIN
  SELECT RAISE(ABORT, 'administrator audit events are append-only');
END;

CREATE TRIGGER trg_admin_audit_events_append_only_update
BEFORE UPDATE ON admin_audit_events
BEGIN
  SELECT RAISE(ABORT, 'administrator audit events are append-only');
END;

CREATE TRIGGER trg_admin_audit_events_append_only_delete
BEFORE DELETE ON admin_audit_events
BEGIN
  SELECT RAISE(ABORT, 'administrator audit events are append-only');
END;

CREATE TRIGGER trg_sessions_event_cursor_valid_insert
BEFORE INSERT ON sessions
WHEN
  typeof(NEW.event_seq) <> 'integer' OR
  typeof(NEW.min_retained_seq) <> 'integer' OR
  NEW.min_retained_seq < 0 OR
  NEW.min_retained_seq > NEW.event_seq
BEGIN
  SELECT RAISE(ABORT, 'Session event cursors must be non-negative and valid');
END;

CREATE TRIGGER trg_sessions_event_cursor_monotonic_update
BEFORE UPDATE OF event_seq, min_retained_seq ON sessions
WHEN
  typeof(NEW.event_seq) <> 'integer' OR
  typeof(NEW.min_retained_seq) <> 'integer' OR
  NEW.min_retained_seq < 0 OR
  NEW.min_retained_seq > NEW.event_seq OR
  NEW.min_retained_seq < OLD.min_retained_seq OR
  NEW.event_seq < OLD.event_seq
BEGIN
  SELECT RAISE(ABORT, 'Session event cursors must be monotonic and valid');
END;
`;

const COLLABORATION_LIVE_DRAFT_SQL = `
CREATE TABLE session_live_drafts (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL UNIQUE CHECK (length(draft_id) BETWEEN 1 AND 128),
  version INTEGER NOT NULL CHECK (version >= 1),
  time TEXT,
  controller TEXT,
  callsign TEXT,
  rst_sent TEXT,
  rst_rcvd TEXT,
  qth TEXT,
  device TEXT,
  power TEXT,
  antenna TEXT,
  height TEXT,
  remarks TEXT,
  field_revisions_json TEXT NOT NULL CHECK (
    json_valid(field_revisions_json) AND json_type(field_revisions_json) = 'object'
  ),
  last_updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 64),
  last_updated_at TEXT NOT NULL CHECK (length(last_updated_at) BETWEEN 20 AND 64),
  last_committed_draft_id TEXT,
  last_committed_version INTEGER CHECK (
    last_committed_version IS NULL OR last_committed_version >= 1
  ),
  last_committed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_committed_at TEXT,
  last_committed_sync_id TEXT,
  CHECK (
    (last_committed_draft_id IS NULL AND last_committed_version IS NULL AND
     last_committed_at IS NULL AND last_committed_sync_id IS NULL) OR
    (last_committed_draft_id IS NOT NULL AND last_committed_version IS NOT NULL AND
     last_committed_at IS NOT NULL AND last_committed_sync_id IS NOT NULL)
  )
);

CREATE INDEX idx_session_live_drafts_updated
ON session_live_drafts(last_updated_at, session_id);

CREATE TABLE live_draft_device_state (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  last_client_seq INTEGER NOT NULL CHECK (last_client_seq >= 1),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 64),
  PRIMARY KEY (session_id, user_id, device_id)
) WITHOUT ROWID;

CREATE INDEX idx_live_draft_device_state_updated
ON live_draft_device_state(updated_at, session_id);

CREATE TRIGGER trg_session_live_drafts_live_session_insert
BEFORE INSERT ON session_live_drafts
WHEN NOT EXISTS (
  SELECT 1 FROM sessions
  WHERE id = NEW.session_id AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Live drafts require a non-deleted Session');
END;

CREATE TRIGGER trg_session_live_drafts_identity_immutable
BEFORE UPDATE OF session_id ON session_live_drafts
WHEN NEW.session_id IS NOT OLD.session_id
BEGIN
  SELECT RAISE(ABORT, 'Live draft Session identity is immutable');
END;

CREATE TRIGGER trg_session_live_drafts_version_monotonic
BEFORE UPDATE OF version ON session_live_drafts
WHEN typeof(NEW.version) <> 'integer' OR NEW.version <= OLD.version
BEGIN
  SELECT RAISE(ABORT, 'Live draft versions must increase');
END;
`;

const SESSION_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['version', 'INTEGER NOT NULL DEFAULT 1'],
  ['event_seq', 'INTEGER NOT NULL DEFAULT 0'],
  ['min_retained_seq', 'INTEGER NOT NULL DEFAULT 0'],
  ['closed_at', 'TEXT'],
  ['closed_by', 'TEXT REFERENCES users(id)'],
];

const LOG_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['version', 'INTEGER NOT NULL DEFAULT 1'],
  ['remarks', 'TEXT'],
  ['created_by', 'TEXT REFERENCES users(id)'],
  ['updated_by', 'TEXT REFERENCES users(id)'],
  ['source_device_id', 'TEXT'],
  ['deleted_by', 'TEXT REFERENCES users(id)'],
];

function checksum(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\n---\n')).digest('hex');
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Unsafe SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${quoteIdentifier(table)})`) as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  declaration: string,
): void {
  if (hasColumn(db, table, column)) return;
  db.exec(
    `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${declaration}`,
  );
}

function ensureServerInstanceId(db: Database.Database): void {
  addColumnIfMissing(db, 'server_settings', 'instance_id', 'TEXT');

  const current = db
    .prepare('SELECT instance_id FROM server_settings WHERE id = 1')
    .get() as { instance_id?: string | null } | undefined;

  if (!current) {
    db.prepare(
      'INSERT INTO server_settings (id, registration_enabled, instance_id) VALUES (1, 1, ?)',
    ).run(randomUUID());
  } else if (!current.instance_id?.trim()) {
    db.prepare('UPDATE server_settings SET instance_id = ? WHERE id = 1').run(randomUUID());
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_server_settings_instance_id
    ON server_settings(instance_id);

    CREATE TRIGGER IF NOT EXISTS trg_server_settings_instance_id_insert
    BEFORE INSERT ON server_settings
    WHEN NEW.instance_id IS NULL OR trim(NEW.instance_id) = ''
    BEGIN
      SELECT RAISE(ABORT, 'server_settings.instance_id is required');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_server_settings_instance_id_update
    BEFORE UPDATE OF instance_id ON server_settings
    WHEN NEW.instance_id IS NULL OR trim(NEW.instance_id) = ''
    BEGIN
      SELECT RAISE(ABORT, 'server_settings.instance_id is required');
    END;
  `);
}

function validateAdministratorAccounts(db: Database.Database): void {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS user_count,
      SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admin_count,
      SUM(CASE WHEN role NOT IN ('admin', 'user') THEN 1 ELSE 0 END) AS invalid_role_count
    FROM users
  `).get() as {
    user_count: number;
    admin_count: number | null;
    invalid_role_count: number | null;
  };

  if (Number(counts.invalid_role_count) > 0) {
    throw new Error('Cannot enable administrator APIs while users contain invalid roles');
  }
  if (Number(counts.user_count) > 0 && Number(counts.admin_count) < 1) {
    throw new Error('Cannot enable administrator APIs without an administrator account');
  }
}

const LOG_BUSINESS_COLUMNS = [
  'controller',
  'callsign',
  'time',
  'rst_sent',
  'rst_rcvd',
  'qth',
  'device',
  'power',
  'antenna',
  'height',
  'remarks',
  'source_device_id',
  'deleted_at',
] as const;

function logBusinessFingerprint(row: SqliteRow): string {
  return JSON.stringify(LOG_BUSINESS_COLUMNS.map((column) => row[column] ?? null));
}

function compareLogRecency(a: SqliteRow, b: SqliteRow): number {
  const updatedComparison = String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''));
  if (updatedComparison !== 0) return updatedComparison;
  return Number(b.id) - Number(a.id);
}

function allocateSyncId(db: Database.Database, sessionId: string): string {
  const exists = db.prepare(
    'SELECT 1 FROM logs WHERE session_id = ? AND sync_id = ? LIMIT 1',
  );

  let candidate = randomUUID();
  while (exists.get(sessionId, candidate)) candidate = randomUUID();
  return candidate;
}

function recordMigrationAudit(
  db: Database.Database,
  action: string,
  row: SqliteRow,
  oldKey: string,
  newKey: string | null,
  details: Record<string, unknown>,
): void {
  db.prepare(`
    INSERT INTO migration_audit (
      migration_version, action, table_name, row_id, old_key, new_key,
      details_json, created_at
    ) VALUES (?, ?, 'logs', ?, ?, ?, ?, ?)
  `).run(
    3,
    action,
    String(row.id),
    oldKey,
    newKey,
    JSON.stringify(details),
    new Date().toISOString(),
  );
}

/**
 * Existing versions of the API allowed duplicate (session_id, sync_id) rows.
 * Identical business rows are collapsed. Distinct business rows are preserved
 * and receive a fresh sync_id so the new uniqueness invariant can be enabled.
 */
function resolveDuplicateLogs(db: Database.Database): void {
  const duplicateKeys = db.prepare(`
    SELECT session_id, sync_id
    FROM logs
    GROUP BY session_id, sync_id
    HAVING COUNT(*) > 1
    ORDER BY session_id, sync_id
  `).all() as Array<{ session_id: string; sync_id: string }>;

  const readRows = db.prepare(`
    SELECT * FROM logs
    WHERE session_id = ? AND sync_id = ?
  `);
  const renameRow = db.prepare('UPDATE logs SET sync_id = ? WHERE id = ?');
  const deleteRow = db.prepare('DELETE FROM logs WHERE id = ?');

  for (const key of duplicateKeys) {
    const rows = (readRows.all(key.session_id, key.sync_id) as SqliteRow[])
      .sort(compareLogRecency);
    const rowsByFingerprint = new Map<string, SqliteRow[]>();

    for (const row of rows) {
      const fingerprint = logBusinessFingerprint(row);
      const matchingRows = rowsByFingerprint.get(fingerprint) ?? [];
      matchingRows.push(row);
      rowsByFingerprint.set(fingerprint, matchingRows);
    }

    let keepsOriginalSyncId = true;
    for (const matchingRows of rowsByFingerprint.values()) {
      const representative = matchingRows[0];
      let representativeSyncId = key.sync_id;

      if (keepsOriginalSyncId) {
        keepsOriginalSyncId = false;
      } else {
        representativeSyncId = allocateSyncId(db, key.session_id);
        renameRow.run(representativeSyncId, representative.id);
        recordMigrationAudit(
          db,
          'reassign_duplicate_log_sync_id',
          representative,
          key.sync_id,
          representativeSyncId,
          {
            reason: 'same session_id and sync_id but different business content',
            preservedRow: representative,
          },
        );
      }

      for (const duplicate of matchingRows.slice(1)) {
        recordMigrationAudit(
          db,
          'merge_identical_duplicate_log',
          duplicate,
          key.sync_id,
          representativeSyncId,
          {
            reason: 'identical business content',
            keptRowId: representative.id,
            removedRow: duplicate,
          },
        );
        deleteRow.run(duplicate.id);
      }
    }
  }
}

function backfillOwnerMemberships(db: Database.Database): void {
  const sessions = db.prepare(`
    SELECT id, owner_user_id, created_at, updated_at
    FROM sessions
    ORDER BY id
  `).all() as Array<{
    id: string;
    owner_user_id: string;
    created_at: string;
    updated_at: string;
  }>;
  const insertMembership = db.prepare(`
    INSERT OR IGNORE INTO session_members (
      id, session_id, user_id, role, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'owner', 1, ?, ?)
  `);

  for (const session of sessions) {
    insertMembership.run(
      randomUUID(),
      session.id,
      session.owner_user_id,
      session.created_at,
      session.updated_at,
    );
  }
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    checksum: checksum('1', 'initial_schema', INITIAL_SCHEMA_SQL),
    up(db) {
      db.exec(INITIAL_SCHEMA_SQL);
    },
  },
  {
    version: 2,
    name: 'operational_metadata_and_refresh_tokens',
    checksum: checksum(
      '2',
      'operational_metadata_and_refresh_tokens',
      OPERATIONAL_SCHEMA_SQL,
      'server_settings.instance_id:v1',
    ),
    up(db) {
      db.exec(OPERATIONAL_SCHEMA_SQL);
      ensureServerInstanceId(db);
    },
  },
  {
    version: 3,
    name: 'collaboration_foundation',
    checksum: checksum(
      '3',
      'collaboration_foundation',
      JSON.stringify(SESSION_COLUMNS),
      JSON.stringify(LOG_COLUMNS),
      'duplicate-log-resolution:v2',
      COLLABORATION_FOUNDATION_SQL,
    ),
    up(db) {
      for (const [column, declaration] of SESSION_COLUMNS) {
        addColumnIfMissing(db, 'sessions', column, declaration);
      }
      for (const [column, declaration] of LOG_COLUMNS) {
        addColumnIfMissing(db, 'logs', column, declaration);
      }

      resolveDuplicateLogs(db);
      db.exec(COLLABORATION_FOUNDATION_SQL);
    },
  },
  {
    version: 4,
    name: 'collaboration_access_and_idempotency',
    checksum: checksum(
      '4',
      'collaboration_access_and_idempotency',
      COLLABORATION_ACCESS_SCHEMA_SQL,
      'backfill-owner-memberships:v1',
    ),
    up(db) {
      db.exec(COLLABORATION_ACCESS_SCHEMA_SQL);
      backfillOwnerMemberships(db);
    },
  },
  {
    version: 5,
    name: 'bind_invite_hmac_instance_key',
    checksum: checksum(
      '5',
      'bind_invite_hmac_instance_key',
      'server_settings.invite_hmac_fingerprint:text:v1',
    ),
    up(db) {
      addColumnIfMissing(db, 'server_settings', 'invite_hmac_fingerprint', 'TEXT');
    },
  },
  {
    version: 6,
    name: 'disable_legacy_collaboration_channels',
    checksum: checksum(
      '6',
      'disable_legacy_collaboration_channels',
      'revoke-active-legacy-shares:v1',
      DISABLE_LEGACY_SHARES_SQL,
    ),
    up(db) {
      db.prepare(`
        UPDATE shares
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE revoked_at IS NULL
      `).run(new Date().toISOString());
      db.exec(DISABLE_LEGACY_SHARES_SQL);
    },
  },
  {
    version: 7,
    name: 'stable_invite_redemption_replays',
    checksum: checksum(
      '7',
      'stable_invite_redemption_replays',
      'invite_redemptions.request_hash:text:v1',
      'invite_redemptions.response_json:text:v1',
    ),
    up(db) {
      addColumnIfMissing(db, 'invite_redemptions', 'request_hash', 'TEXT');
      addColumnIfMissing(db, 'invite_redemptions', 'response_json', 'TEXT');
    },
  },
  {
    version: 8,
    name: 'collaboration_realtime_events',
    checksum: checksum(
      '8',
      'collaboration_realtime_events',
      COLLABORATION_REALTIME_SQL,
    ),
    up(db) {
      db.exec(COLLABORATION_REALTIME_SQL);
    },
  },
  {
    version: 9,
    name: 'runtime_admin_audit',
    checksum: checksum(
      '9',
      'runtime_admin_audit',
      RUNTIME_ADMIN_AUDIT_SQL,
      'validate-administrator-accounts:v1',
    ),
    up(db) {
      validateAdministratorAccounts(db);
      db.exec(RUNTIME_ADMIN_AUDIT_SQL);
    },
  },
  {
    version: 10,
    name: 'collaboration_security_audit',
    checksum: checksum(
      '10',
      'collaboration_security_audit',
      COLLABORATION_AUDIT_SQL,
    ),
    up(db) {
      db.exec(COLLABORATION_AUDIT_SQL);
    },
  },
  {
    version: 11,
    name: 'public_liveshare_capabilities',
    checksum: checksum(
      '11',
      'public_liveshare_capabilities',
      'server_settings.public_share_hmac_fingerprint:text:v1',
      'preserve-collaboration-audit-events:v1',
      PUBLIC_LIVESHARE_CAPABILITIES_SQL,
    ),
    up(db) {
      addColumnIfMissing(db, 'server_settings', 'public_share_hmac_fingerprint', 'TEXT');
      const auditRowsBefore = Number(
        db.prepare('SELECT COUNT(*) FROM collaboration_audit_events').pluck().get(),
      );
      db.exec(PUBLIC_LIVESHARE_CAPABILITIES_SQL);
      const auditRowsAfter = Number(
        db.prepare('SELECT COUNT(*) FROM collaboration_audit_events').pluck().get(),
      );
      if (auditRowsAfter !== auditRowsBefore) {
        throw new Error('Public Liveshare migration did not preserve collaboration audit rows');
      }
    },
  },
  {
    version: 12,
    name: 'session_event_retention',
    checksum: checksum(
      '12',
      'session_event_retention',
      'preserve-admin-audit-events:v1',
      'validate-existing-session-event-cursors:v1',
      SESSION_EVENT_RETENTION_SQL,
    ),
    up(db) {
      const invalidSessionCursorCount = Number(db.prepare(`
        SELECT COUNT(*)
        FROM sessions
        WHERE
          typeof(event_seq) <> 'integer' OR
          typeof(min_retained_seq) <> 'integer' OR
          event_seq < 0 OR
          min_retained_seq < 0 OR
          min_retained_seq > event_seq
      `).pluck().get());
      if (invalidSessionCursorCount > 0) {
        throw new Error(
          'Cannot enable Session event retention while Session cursors are invalid',
        );
      }
      const auditRowsBefore = Number(
        db.prepare('SELECT COUNT(*) FROM admin_audit_events').pluck().get(),
      );
      db.exec(SESSION_EVENT_RETENTION_SQL);
      const auditRowsAfter = Number(
        db.prepare('SELECT COUNT(*) FROM admin_audit_events').pluck().get(),
      );
      if (auditRowsAfter !== auditRowsBefore) {
        throw new Error(
          'Session event retention migration did not preserve administrator audit rows',
        );
      }
    },
  },
  {
    version: 13,
    name: 'collaboration_live_draft',
    checksum: checksum(
      '13',
      'collaboration_live_draft',
      'single-persistent-draft-per-session:v1',
      'bounded-device-replay-state:v1',
      COLLABORATION_LIVE_DRAFT_SQL,
    ),
    up(db) {
      db.exec(COLLABORATION_LIVE_DRAFT_SQL);
    },
  },
];

function validateMigrationDefinitions(): void {
  let previousVersion = 0;
  const names = new Set<string>();

  for (const migration of migrations) {
    if (migration.version <= previousVersion) {
      throw new Error('Database migrations must have strictly increasing versions');
    }
    if (names.has(migration.name)) {
      throw new Error(`Duplicate database migration name: ${migration.name}`);
    }
    previousVersion = migration.version;
    names.add(migration.name);
  }
}

export function runMigrations(db: Database.Database): void {
  if (db.inTransaction) {
    throw new Error('Database migrations cannot run inside an existing transaction');
  }

  validateMigrationDefinitions();
  db.exec(SCHEMA_MIGRATIONS_SQL);

  const appliedRows = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as AppliedMigrationRow[];
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]));
  const knownVersions = new Set(migrations.map((migration) => migration.version));

  for (const applied of appliedRows) {
    if (!knownVersions.has(applied.version)) {
      throw new Error(
        `Database migration ${applied.version} (${applied.name}) is newer than this server`,
      );
    }
  }

  for (let index = 0; index < appliedRows.length; index += 1) {
    if (appliedRows[index].version !== migrations[index].version) {
      throw new Error(
        'Applied database migrations must be a contiguous prefix of known migrations',
      );
    }
  }

  const recordMigration = db.prepare(`
    INSERT INTO schema_migrations (version, name, checksum, applied_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const migration of migrations) {
    const applied = appliedByVersion.get(migration.version);
    if (applied) {
      if (applied.name !== migration.name || applied.checksum !== migration.checksum) {
        throw new Error(
          `Database migration ${migration.version} checksum mismatch; ` +
          `expected ${migration.name}/${migration.checksum}, ` +
          `found ${applied.name}/${applied.checksum}`,
        );
      }
      continue;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      recordMigration.run(
        migration.version,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw new Error(
        `Failed to apply database migration ${migration.version} (${migration.name})`,
        { cause: error },
      );
    }
  }
}
