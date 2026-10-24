// src/errors.ts
export class AppError extends Error {
  constructor(message: string, public statusCode = 400, public code = "BAD_REQUEST") {
    super(message);
    this.name = this.constructor.name;
  }
}
export class ValidationError extends AppError {
  constructor(message: string) { super(message, 400, "VALIDATION_ERROR"); }
}
export class ConflictError extends AppError {
  constructor(message: string) { super(message, 409, "CONFLICT"); }
}
export class UnauthorizedError extends AppError {
  constructor(message: string) { super(message, 401, "UNAUTHORIZED"); }
}