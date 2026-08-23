import Database from 'better-sqlite3';
import { Router } from 'express';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import {
  defaultExcelExportSettings,
  ExcelExportSettings,
  EXCEL_EXPORT_SETTINGS_FORMAT_VERSION,
  validateExcelExportSettings,
} from '../excel-export-settings/model';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { rejectUnknownKeys, requireJsonObject } from '../utils/validation';

interface ExcelExportSettingsV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
}

interface ExcelExportSettingsRow {
  user_id: string;
  format_version: number;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

function readRow(
  db: Database.Database,
  userId: string,
): ExcelExportSettingsRow | undefined {
  return db.prepare(`
    SELECT user_id, format_version, settings_json, created_at, updated_at
    FROM account_excel_export_settings
    WHERE user_id = ?
  `).get(userId) as ExcelExportSettingsRow | undefined;
}

function decodeStoredSettings(row: ExcelExportSettingsRow): ExcelExportSettings {
  try {
    if (Number(row.format_version) !== EXCEL_EXPORT_SETTINGS_FORMAT_VERSION) {
      throw new Error('unsupported persisted format version');
    }
    return validateExcelExportSettings(JSON.parse(row.settings_json) as unknown);
  } catch (error) {
    throw new AppError(
      500,
      'EXCEL_EXPORT_SETTINGS_CORRUPT',
      'The stored Excel export settings are invalid',
      undefined,
      { cause: error },
    );
  }
}

function response(row?: ExcelExportSettingsRow) {
  return {
    excelExportSettings: row ? decodeStoredSettings(row) : defaultExcelExportSettings(),
    persisted: Boolean(row),
    updatedAt: row?.updated_at ?? null,
  };
}

export function createExcelExportSettingsV1Router(
  dependencies: ExcelExportSettingsV1Dependencies = {},
): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(createAccessTokenMiddleware(runtimeConfig, database));

  router.get('/excel-export-settings', (req: V1AuthRequest, res, next) => {
    try {
      res.json(response(readRow(database(), req.auth!.userId)));
    } catch (error) {
      next(error);
    }
  });

  router.put('/excel-export-settings', (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['excelExportSettings']);
      const settings = validateExcelExportSettings(body.excelExportSettings);
      const serialized = JSON.stringify(settings);
      const db = database();
      const current = readRow(db, req.auth!.userId);
      if (current?.settings_json === serialized) {
        res.json(response(current));
        return;
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO account_excel_export_settings (
          user_id, format_version, settings_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          format_version = excluded.format_version,
          settings_json = excluded.settings_json,
          updated_at = excluded.updated_at
      `).run(
        req.auth!.userId,
        EXCEL_EXPORT_SETTINGS_FORMAT_VERSION,
        serialized,
        now,
        now,
      );
      const saved = readRow(db, req.auth!.userId);
      if (!saved) {
        throw new AppError(
          500,
          'EXCEL_EXPORT_SETTINGS_WRITE_FAILED',
          'Excel export settings were not persisted',
        );
      }
      res.json(response(saved));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
