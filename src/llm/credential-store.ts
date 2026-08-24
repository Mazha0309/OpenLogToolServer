import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import Database from 'better-sqlite3';
import { AppConfig } from '../config';
import { AppError } from '../errors/app-error';

interface CredentialRow {
  encrypted_api_key: string;
  key_fingerprint: string;
  created_at: string;
  updated_at: string;
}

export interface LlmCredentialStatus {
  configured: boolean;
  source: 'database' | 'environment' | 'none';
  updatedAt: string | null;
}

const AAD = Buffer.from('openlogtool/server-llm-api-key/v1', 'utf8');

function encryptionKey(jwtSecret: string): Buffer {
  return createHash('sha256')
    .update('openlogtool/server-llm-credential-key/v1\0', 'utf8')
    .update(jwtSecret, 'utf8')
    .digest();
}

function fingerprint(key: Buffer): string {
  return createHash('sha256').update('fingerprint\0').update(key).digest('hex');
}

function encrypt(apiKey: string, jwtSecret: string): { value: string; fingerprint: string } {
  const key = encryptionKey(jwtSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    value: `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`,
    fingerprint: fingerprint(key),
  };
}

function decrypt(row: CredentialRow, jwtSecret: string): string {
  const key = encryptionKey(jwtSecret);
  if (row.key_fingerprint !== fingerprint(key)) {
    throw new AppError(
      503,
      'LLM_CREDENTIAL_KEY_CHANGED',
      'The stored LLM API key cannot be decrypted after the server secret changed. Re-enter it in Server settings.',
    );
  }
  const [version, ivText, tagText, ciphertextText, ...extra] = row.encrypted_api_key.split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText || extra.length > 0) {
    throw new AppError(500, 'LLM_CREDENTIAL_INVALID', 'The stored LLM credential is invalid');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    throw new AppError(503, 'LLM_CREDENTIAL_DECRYPT_FAILED', 'The stored LLM API key could not be decrypted', undefined, {
      cause: error,
    });
  }
}

function storedRow(db: Database.Database): CredentialRow | undefined {
  return db.prepare(`
    SELECT encrypted_api_key, key_fingerprint, created_at, updated_at
    FROM server_llm_credentials WHERE id = 1
  `).get() as CredentialRow | undefined;
}

export function llmCredentialStatus(
  db: Database.Database,
  config: AppConfig,
): LlmCredentialStatus {
  const row = storedRow(db);
  if (row) return { configured: true, source: 'database', updatedAt: row.updated_at };
  if (config.llmApiKey.trim()) return { configured: true, source: 'environment', updatedAt: null };
  return { configured: false, source: 'none', updatedAt: null };
}

export function resolveLlmApiKey(db: Database.Database, config: AppConfig): string {
  const row = storedRow(db);
  if (row) return decrypt(row, config.jwtSecret).trim();
  return config.llmApiKey.trim();
}

export function storeLlmApiKey(
  db: Database.Database,
  config: AppConfig,
  apiKey: string,
  updatedBy: string,
  now = new Date().toISOString(),
): LlmCredentialStatus {
  const normalized = apiKey.trim();
  if (!normalized || normalized.length > 8_192) {
    throw new AppError(422, 'VALIDATION_FAILED', 'apiKey must contain between 1 and 8192 characters');
  }
  const sealed = encrypt(normalized, config.jwtSecret);
  db.prepare(`
    INSERT INTO server_llm_credentials (
      id, encrypted_api_key, key_fingerprint, updated_by, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      encrypted_api_key = excluded.encrypted_api_key,
      key_fingerprint = excluded.key_fingerprint,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(sealed.value, sealed.fingerprint, updatedBy, now, now);
  return { configured: true, source: 'database', updatedAt: now };
}

export function removeStoredLlmApiKey(
  db: Database.Database,
  config: AppConfig,
): LlmCredentialStatus {
  db.prepare('DELETE FROM server_llm_credentials WHERE id = 1').run();
  return llmCredentialStatus(db, config);
}
