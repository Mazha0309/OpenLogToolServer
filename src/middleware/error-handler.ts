import { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../errors/app-error';

interface JsonSyntaxError extends SyntaxError {
  status?: number;
  type?: string;
}

interface CodedError extends Error {
  code?: string;
  status?: number;
  type?: string;
}

export const notFoundMiddleware: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
};

export const errorMiddleware: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  let appError: AppError;
  const syntaxError = error as JsonSyntaxError;
  const codedError = error as CodedError;
  if (
    error instanceof SyntaxError &&
    (syntaxError.status === 400 || syntaxError.type === 'entity.parse')
  ) {
    appError = new AppError(400, 'INVALID_JSON', 'Request body contains invalid JSON');
  } else if (codedError.status === 413 || codedError.type === 'entity.too.large') {
    appError = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  } else if (codedError.code === 'SQLITE_BUSY' || codedError.code === 'SQLITE_LOCKED') {
    appError = new AppError(503, 'DATABASE_BUSY', 'Database is busy; retry later');
  } else if (error instanceof AppError) {
    appError = error;
  } else {
    appError = new AppError(500, 'INTERNAL_ERROR', 'Internal server error', undefined, {
      cause: error,
    });
  }

  const requestId = String(res.locals.requestId || 'unknown');
  if (appError.status >= 500) {
    console.error(`[${requestId}]`, error);
  }

  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      requestId,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
  });
};
