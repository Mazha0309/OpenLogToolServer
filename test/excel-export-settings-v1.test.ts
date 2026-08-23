import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import { defaultExcelExportSettings } from '../src/excel-export-settings/model';

interface HttpResult {
  status: number;
  headers: Headers;
  body: any;
}

const JWT_SECRET = 'excel-settings-test-secret-68fd3aca-1351-48ae-b63b';
const JWT_ISSUER = 'excel-settings-test';
const FIRST_USER = 'excel-settings-first-user';
const SECOND_USER = 'excel-settings-second-user';
const NOW = '2026-08-23T00:00:00.000Z';

function token(userId: string): string {
  return jwt.sign(
    { type: 'access', role: 'user', jti: randomUUID(), av: 1 },
    JWT_SECRET,
    {
      algorithm: 'HS256',
      issuer: JWT_ISSUER,
      audience: 'openlogtool-v1',
      subject: userId,
      expiresIn: 300,
    },
  );
}

describe('account Excel export settings v1', () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-excel-settings-'));
    db = openDatabase(join(directory, 'test.db'));
    const insertUser = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'unused-hash', 'user', ?, ?)
    `);
    insertUser.run(FIRST_USER, 'excel-first', NOW, NOW);
    insertUser.run(SECOND_USER, 'excel-second', NOW, NOW);
    server = createServer(createApp({
      db,
      config: {
        jwtSecret: JWT_SECRET,
        jwtIssuer: JWT_ISSUER,
        rateLimitEnabled: false,
        environment: 'test',
      },
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function request(
    options: { method?: string; userId?: string; body?: unknown } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}/api/v1/account/excel-export-settings`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.userId ? { authorization: `Bearer ${token(options.userId)}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  }

  test('migration v27 creates an account-owned cascading settings table', () => {
    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 27').get(),
      { version: 27, name: 'account_excel_export_settings' },
    );
    const columns = (db.pragma('table_info(account_excel_export_settings)') as Array<{
      name: string;
    }>).map((column) => column.name);
    assert.deepEqual(columns, [
      'user_id',
      'format_version',
      'settings_json',
      'created_at',
      'updated_at',
    ]);
  });

  test('requires authentication and returns client-compatible defaults without writing', async () => {
    const unauthorized = await request();
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error.code, 'AUTH_REQUIRED');

    const result = await request({ userId: FIRST_USER });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(result.body, {
      excelExportSettings: defaultExcelExportSettings(),
      persisted: false,
      updatedAt: null,
    });
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM account_excel_export_settings').pluck().get(),
      0,
    );
  });

  test('persists strict settings per account and canonicalizes opaque colors', async () => {
    const settings = {
      ...defaultExcelExportSettings(),
      headerText: '{yyyy} 周末点名',
      useSessionTitleAsHeader: false,
      useSessionTitleAsFileName: false,
      headerBackgroundColor: '#11223380',
      tableBackgroundColor: '#445566',
      fontFamily: 'Custom Radio Font',
      showFooter: false,
      fileNameTemplate: '{session}_{yyyy}-{MM}-{dd}',
    };
    const saved = await request({
      method: 'PUT',
      userId: FIRST_USER,
      body: { excelExportSettings: settings },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.persisted, true);
    assert.equal(saved.body.excelExportSettings.headerBackgroundColor, '#11223380');
    assert.equal(saved.body.excelExportSettings.tableBackgroundColor, '#445566FF');
    assert.equal(typeof saved.body.updatedAt, 'string');

    const first = await request({ userId: FIRST_USER });
    assert.deepEqual(first.body, saved.body);
    const second = await request({ userId: SECOND_USER });
    assert.equal(second.body.persisted, false);
    assert.deepEqual(second.body.excelExportSettings, defaultExcelExportSettings());

    const row = db.prepare(`
      SELECT user_id, format_version, settings_json
      FROM account_excel_export_settings
    `).get() as { user_id: string; format_version: number; settings_json: string };
    assert.equal(row.user_id, FIRST_USER);
    assert.equal(row.format_version, 1);
    assert.deepEqual(JSON.parse(row.settings_json), saved.body.excelExportSettings);
  });

  test('rejects unknown, incomplete and malformed settings without changing the row', async () => {
    const before = db.prepare(`
      SELECT settings_json, updated_at FROM account_excel_export_settings WHERE user_id = ?
    `).get(FIRST_USER);
    for (const excelExportSettings of [
      { ...defaultExcelExportSettings(), unknown: true },
      { ...defaultExcelExportSettings(), fontFamily: undefined },
      { ...defaultExcelExportSettings(), alternateRowColor: 'pink' },
      { ...defaultExcelExportSettings(), formatVersion: 2 },
    ]) {
      const result = await request({
        method: 'PUT',
        userId: FIRST_USER,
        body: { excelExportSettings },
      });
      assert.equal(result.status, 422);
    }
    assert.deepEqual(
      db.prepare(`
        SELECT settings_json, updated_at FROM account_excel_export_settings WHERE user_id = ?
      `).get(FIRST_USER),
      before,
    );
  });

  test('deleting an account removes only its persisted Excel settings', async () => {
    await request({
      method: 'PUT',
      userId: SECOND_USER,
      body: { excelExportSettings: defaultExcelExportSettings() },
    });
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM account_excel_export_settings').pluck().get(),
      2,
    );
    db.prepare('DELETE FROM users WHERE id = ?').run(SECOND_USER);
    assert.deepEqual(
      db.prepare(`
        SELECT user_id FROM account_excel_export_settings ORDER BY user_id
      `).all(),
      [{ user_id: FIRST_USER }],
    );
  });
});
