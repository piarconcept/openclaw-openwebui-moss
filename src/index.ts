import { startPlugin, stopPlugin } from './runtime/start.js';
import type { ActivationContext } from './runtime/start.js';

export async function activate(ctx?: ActivationContext): Promise<void> {
  await startPlugin(ctx);
}

export async function deactivate(): Promise<void> {
  await stopPlugin();
}
