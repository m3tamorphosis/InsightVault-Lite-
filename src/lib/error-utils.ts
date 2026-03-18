export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (error && typeof error === 'object') {
    const candidate = error as {
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
      error_description?: unknown;
    };

    const parts = [candidate.message, candidate.details, candidate.hint, candidate.code, candidate.error_description]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    if (parts.length > 0) {
      return parts.join(' | ');
    }
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
}
