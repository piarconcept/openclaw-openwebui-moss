export class OperationalError extends Error {
  public readonly code: string;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class ConfigError extends OperationalError {
  public readonly issues: string[];

  public constructor(issues: string[]) {
    super('CONFIG_INVALID', `Configuration is invalid:\n- ${issues.join('\n- ')}`, {
      issues,
    });
    this.issues = issues;
  }
}

export class AuthorizationError extends OperationalError {}
export class AuthenticationError extends OperationalError {}
export class RoutingError extends OperationalError {}
export class AttachmentError extends OperationalError {}
export class RateLimitError extends OperationalError {}
export class IntegrationError extends OperationalError {}
