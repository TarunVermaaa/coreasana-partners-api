import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { isProduction } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new ApiError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

/** Every error leaves the API in one shape: { error: { code, message, details? } }. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  // Malformed JSON body
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'The request body is not valid JSON' } });
  }
  // An id that isn't an ObjectId can't match anything
  if (err instanceof mongoose.Error.CastError) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  }
  // A unique index caught a duplicate the service didn't (e.g. two signups racing for one code)
  if ((err as { code?: number }).code === 11000) {
    const field = Object.keys((err as { keyPattern?: object }).keyPattern ?? {})[0] ?? 'value';
    return res.status(409).json({ error: { code: 'CONFLICT', message: `That ${field} is already in use`, details: [{ field, message: 'Already in use' }] } });
  }

  logger.error('Unhandled error', { method: req.method, path: req.path, error: err instanceof Error ? err.stack : String(err) });
  res.status(500).json({
    error: { code: 'INTERNAL', message: isProduction ? 'Something went wrong on our side. Please try again.' : String((err as Error)?.message ?? err) },
  });
}
