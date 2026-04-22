import { randomUUID } from 'node:crypto';

const LOG_LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

export type LogLevel = keyof typeof LOG_LEVEL_PRIORITY;
export type LogMeta = Record<string, unknown>;

export interface Logger {
  child(context: LogMeta): Logger;
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shouldRedact(key: string): boolean {
  return /(token|secret|authorization|cookie|password)/iu.test(key);
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, seen));
  }

  if (isRecord(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    const sanitized: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = shouldRedact(key) ? '[REDACTED]' : sanitizeValue(entry, seen);
    }

    return sanitized;
  }

  return value;
}

class JsonLogger implements Logger {
  public constructor(
    private readonly level: LogLevel,
    private readonly context: LogMeta,
  ) {}

  public child(context: LogMeta): Logger {
    return new JsonLogger(this.level, {
      ...this.context,
      ...context,
    });
  }

  public debug(message: string, meta?: LogMeta): void {
    this.log('debug', message, meta);
  }

  public info(message: string, meta?: LogMeta): void {
    this.log('info', message, meta);
  }

  public warn(message: string, meta?: LogMeta): void {
    this.log('warn', message, meta);
  }

  public error(message: string, meta?: LogMeta): void {
    this.log('error', message, meta);
  }

  private log(level: LogLevel, message: string, meta?: LogMeta): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.level]) {
      return;
    }

    const sanitizedContext = sanitizeValue(this.context, new WeakSet<object>());
    const sanitizedMeta = meta ? sanitizeValue(meta, new WeakSet<object>()) : undefined;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(isRecord(sanitizedContext) ? sanitizedContext : {}),
      ...(isRecord(sanitizedMeta) ? sanitizedMeta : {}),
    };

    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}

export function createLogger(options?: {
  level?: LogLevel;
  context?: LogMeta;
}): Logger {
  return new JsonLogger(options?.level ?? 'info', options?.context ?? {});
}

export function createCorrelationId(seed?: string): string {
  const suffix = randomUUID();
  if (!seed) {
    return suffix;
  }

  const normalizedSeed = seed.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48);
  return `${normalizedSeed}-${suffix}`;
}
