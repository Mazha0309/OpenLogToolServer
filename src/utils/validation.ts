import { AppError } from '../errors/app-error';

type JsonObject = Record<string, unknown>;

export function requireJsonObject(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Request body must be a JSON object');
  }
  return value as JsonObject;
}

export function rejectUnknownKeys(value: JsonObject, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Request contains unknown fields', {
      fields: unknown,
    });
  }
}

export function requireString(
  value: JsonObject,
  field: string,
  options: { min?: number; max?: number; trim?: boolean } = {},
): string {
  if (typeof value[field] !== 'string') {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a string`, { field });
  }
  const result = options.trim === false ? value[field] : value[field].trim();
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (result.length < min || result.length > max) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      `${field} length must be between ${min} and ${max}`,
      { field, min, max },
    );
  }
  return result;
}

export function optionalString(
  value: JsonObject,
  field: string,
  options: { min?: number; max?: number; trim?: boolean } = {},
): string | undefined {
  if (value[field] === undefined) return undefined;
  return requireString(value, field, options);
}

export function optionalUuid(value: JsonObject, field: string): string | undefined {
  const result = optionalString(value, field, { min: 36, max: 36 });
  if (result === undefined) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a UUID`, { field });
  }
  return result.toLowerCase();
}
