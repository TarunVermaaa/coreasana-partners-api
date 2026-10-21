import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { ApiError } from '../lib/errors.js';

type Part = 'body' | 'query' | 'params';
const STORE = Symbol('validated');

/**
 * Validates one part of the request with a Zod schema and stores the parsed (coerced, defaulted)
 * value. Failures become a 400 with one message per field, ready to show next to form inputs.
 */
export function validate(part: Part, schema: ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[part] ?? {});
    if (!result.success) {
      return next(
        ApiError.validation(
          result.error.issues.map((i) => ({ field: i.path.join('.') || part, message: i.message })),
        ),
      );
    }
    const bag = ((req as unknown as Record<symbol, Partial<Record<Part, unknown>>>)[STORE] ??= {});
    bag[part] = result.data;
    next();
  };
}

/** The parsed value from validate(). Express 5 makes req.query read-only, so it lives here instead. */
export function valid<T>(req: Request, part: Part): T {
  return (req as unknown as Record<symbol, Partial<Record<Part, unknown>>>)[STORE]?.[part] as T;
}
