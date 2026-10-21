import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import type { Actor } from '../models/commission.js';
import type { StaffRole } from '../models/staff.js';

export type Role = 'affiliate' | StaffRole;

export interface AuthContext {
  id: string;
  role: Role;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      rawBody?: Buffer;
    }
  }
}

// Partners stay signed in on their phone for 30 days; staff sessions last a working day.
const TTL: Record<Role, number> = { affiliate: 60 * 60 * 24 * 30, ops: 60 * 60 * 12, finance: 60 * 60 * 12, admin: 60 * 60 * 12 };

export function signToken(ctx: AuthContext) {
  return jwt.sign({ sub: ctx.id, role: ctx.role, name: ctx.name }, env.JWT_SECRET, { expiresIn: TTL[ctx.role] });
}

/**
 * Bearer tokens for both clients. The mobile app can't rely on cookies, and one scheme keeps the API
 * simple; the dashboard keeps its token in memory/sessionStorage, never localStorage.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) return next(ApiError.unauthenticated());
  try {
    const claims = jwt.verify(token, env.JWT_SECRET) as { sub: string; role: Role; name: string };
    req.auth = { id: claims.sub, role: claims.role, name: claims.name };
    next();
  } catch {
    next(ApiError.unauthenticated('Your session has expired. Please log in again.'));
  }
}

/** Role check. `admin` can do anything a staff role can. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = req.auth?.role;
    if (!role) return next(ApiError.unauthenticated());
    const isStaffRoute = roles.some((r) => r !== 'affiliate');
    if (roles.includes(role) || (role === 'admin' && isStaffRoute)) return next();
    next(ApiError.forbidden());
  };
}

export function auth(req: Request): AuthContext {
  if (!req.auth) throw ApiError.unauthenticated();
  return req.auth;
}

/** Who to credit in history and the audit log. */
export function actorOf(req: Request): Actor {
  const a = auth(req);
  return { type: a.role === 'affiliate' ? 'affiliate' : 'staff', id: a.id, name: a.name };
}
