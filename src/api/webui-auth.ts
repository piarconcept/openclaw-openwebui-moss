import type { RuntimeAuthConfig } from '../types/config.js';
import { AuthenticationError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';

interface SignInResponse {
  token?: string;
}

interface GetTokenOptions {
  forceRefresh?: boolean;
}

interface CreateWebUIAuthSessionOptions {
  baseUrl: string;
  auth: RuntimeAuthConfig;
  logger: Logger;
}

export interface WebUIAuthSession {
  readonly mode: RuntimeAuthConfig['mode'];
  canRefresh(): boolean;
  disable(error: AuthenticationError): void;
  invalidate(): void;
  isDisabled(): boolean;
  getToken(options?: GetTokenOptions): Promise<string>;
}

async function readResponseDetail(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as { detail?: unknown; message?: unknown };
      if (typeof body.detail === 'string' && body.detail.trim() !== '') {
        return body.detail.trim();
      }
      if (typeof body.message === 'string' && body.message.trim() !== '') {
        return body.message.trim();
      }
      return undefined;
    }

    const text = (await response.text()).trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

abstract class BaseAuthSession implements WebUIAuthSession {
  protected disabledError: AuthenticationError | null = null;

  public abstract readonly mode: RuntimeAuthConfig['mode'];

  public abstract canRefresh(): boolean;

  public disable(error: AuthenticationError): void {
    this.disabledError = error;
    this.invalidate();
  }

  public isDisabled(): boolean {
    return this.disabledError !== null;
  }

  protected assertAvailable(): void {
    if (this.disabledError) {
      throw this.disabledError;
    }
  }

  public abstract invalidate(): void;
  public abstract getToken(options?: GetTokenOptions): Promise<string>;
}

class TokenAuthSession extends BaseAuthSession {
  public readonly mode = 'token' as const;

  public constructor(private readonly token: string) {
    super();
  }

  public canRefresh(): boolean {
    return false;
  }

  public invalidate(): void {
    // Static testing token only; there is nothing to refresh in-memory.
  }

  public async getToken(): Promise<string> {
    this.assertAvailable();
    return this.token;
  }
}

class PasswordAuthSession extends BaseAuthSession {
  public readonly mode = 'password' as const;
  private cachedToken: string | null = null;
  private inFlightAuthentication: Promise<string> | null = null;

  public constructor(
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly password: string,
    private readonly logger: Logger,
  ) {
    super();
  }

  public canRefresh(): boolean {
    return true;
  }

  public invalidate(): void {
    this.cachedToken = null;
  }

  public async getToken(options?: GetTokenOptions): Promise<string> {
    this.assertAvailable();

    if (!options?.forceRefresh && this.cachedToken) {
      return this.cachedToken;
    }

    if (!this.inFlightAuthentication) {
      this.inFlightAuthentication = this.authenticate(options?.forceRefresh === true);
    }

    try {
      const token = await this.inFlightAuthentication;
      this.cachedToken = token;
      this.disabledError = null;
      return token;
    } finally {
      this.inFlightAuthentication = null;
    }
  }

  private async authenticate(isRefresh: boolean): Promise<string> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}/api/v1/auths/signin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: this.email,
          password: this.password,
        }),
      });
    } catch (error) {
      const authError = new AuthenticationError(
        'WEBUI_AUTH_REQUEST_FAILED',
        'Failed to contact Open WebUI authentication endpoint',
        {
          mode: this.mode,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      this.disable(authError);
      throw authError;
    }

    if (!response.ok) {
      const detail = await readResponseDetail(response);
      const authError = new AuthenticationError(
        'WEBUI_AUTH_FAILED',
        'Open WebUI bot authentication failed',
        {
          mode: this.mode,
          status: response.status,
          ...(detail ? { detail } : {}),
        },
      );
      this.disable(authError);
      throw authError;
    }

    const payload = (await response.json()) as SignInResponse;
    if (typeof payload.token !== 'string' || payload.token.trim() === '') {
      const authError = new AuthenticationError(
        'WEBUI_AUTH_FAILED',
        'Open WebUI authentication succeeded but returned no session token',
        {
          mode: this.mode,
        },
      );
      this.disable(authError);
      throw authError;
    }

    this.logger.info(
      isRefresh ? 'Refreshed Open WebUI bot session token' : 'Authenticated Open WebUI bot session',
      {
        mode: this.mode,
      },
    );

    return payload.token;
  }
}

export function createWebUIAuthSession(options: CreateWebUIAuthSessionOptions): WebUIAuthSession {
  if (options.auth.mode === 'token') {
    return new TokenAuthSession(options.auth.token);
  }

  return new PasswordAuthSession(
    options.baseUrl,
    options.auth.email,
    options.auth.password,
    options.logger,
  );
}
