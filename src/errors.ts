export type ErrorDetails = Record<string, string | number | boolean>;

export class CliError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly nextSteps: string[];
  readonly details?: ErrorDetails;

  constructor(code: string, message: string, options: { retryable?: boolean; nextSteps?: string[]; details?: ErrorDetails } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.nextSteps = options.nextSteps?.length ? options.nextSteps : ["Run zap --help to review usage."];
    this.details = options.details;
  }
}

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/gu,
  /\b(?:key|sk|pk|rk)_[A-Za-z0-9]{8,}\b/gu,
  /("?(?:authorization|api[_-]?key|token|secret|password|client_secret)"?\s*[:=]\s*)("[^"]*"|\S+)/giu,
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, (match, prefix?: string) => (typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}[redacted]` : "[redacted]")), text);
}

function sdkError(error: { name?: string; message?: string; statusCode?: number; status?: number }): CliError {
  const name = error.name ?? "";
  const message = redact(error.message ?? "Zapier request failed.").slice(0, 500);
  const status = error.statusCode ?? error.status;
  const details: ErrorDetails = status ? { status } : {};
  if (name === "ZapierAuthenticationError" || status === 401) {
    return new CliError("auth_required", "Zapier authentication is missing or expired.", { nextSteps: ["Run zapier-sdk login.", "Then rerun zap auth status."], details });
  }
  if (name === "ZapierRateLimitError" || status === 429) return new CliError("rate_limited", message, { retryable: true, nextSteps: ["Wait, then retry."], details });
  if (name === "ZapierNotFoundError" || name === "ZapierResourceNotFoundError" || name === "ZapierAppNotFoundError" || status === 404) {
    return new CliError("not_found", message, { nextSteps: ["Check the id or key, then retry."], details });
  }
  if (name === "ZapierValidationError" || status === 400 || status === 422) return new CliError("validation_error", message, { nextSteps: ["Correct the input and retry."], details });
  if (name === "ZapierConflictError" || status === 409) return new CliError("conflict", message, { nextSteps: ["Re-read the resource to get its current revision, then retry."], details });
  if (status === 403) return new CliError("forbidden", message, { nextSteps: ["Check that the logged-in Zapier account can access this resource."], details });
  if (name === "ZapierTimeoutError" || (status !== undefined && status >= 500)) {
    return new CliError("provider_unavailable", message, { nextSteps: ["Read the resource to confirm whether a write landed before retrying."], details });
  }
  return new CliError("provider_error", message, { nextSteps: ["Rerun with the same input or inspect the resource in Zapier."], details });
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string" && String((error as { name: string }).name).startsWith("Zapier")) {
    return sdkError(error as { name?: string; message?: string; statusCode?: number });
  }
  return new CliError("unexpected_error", "The command failed unexpectedly.", { nextSteps: ["Run the command again or report the failure."] });
}

export function errorPayload(error: unknown): object {
  const safe = toCliError(error);
  return {
    ok: false,
    error: {
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
      next_steps: safe.nextSteps,
      ...(safe.details ? { details: safe.details } : {}),
    },
  };
}
