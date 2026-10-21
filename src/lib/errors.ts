export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INVALID_SIGNATURE'
  | 'INTERNAL';

export interface FieldError {
  field: string;
  message: string;
}

/** An error that maps to a specific HTTP response. Anything else becomes a generic 500. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: FieldError[],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static validation(details: FieldError[], message = 'Some fields need attention') {
    return new ApiError(400, 'VALIDATION_ERROR', message, details);
  }
  static unauthenticated(message = 'Please log in to continue') {
    return new ApiError(401, 'UNAUTHENTICATED', message);
  }
  static forbidden(message = 'Your role cannot do this') {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(what: string) {
    return new ApiError(404, 'NOT_FOUND', `${what} not found`);
  }
  static conflict(message: string, details?: FieldError[]) {
    return new ApiError(409, 'CONFLICT', message, details);
  }
}
