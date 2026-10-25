import { openRuntime, type Runtime } from '../runtime';

// One runtime per server process, kept on globalThis so Next's dev reloads reuse its pools instead of opening more.
const KEY = '__mnemioRuntime';
const g = globalThis as typeof globalThis & { [KEY]?: Runtime };

export function getRuntime(): Runtime {
  g[KEY] ??= openRuntime(process.env);
  return g[KEY];
}

export async function closeRuntime(): Promise<void> {
  const rt = g[KEY];
  delete g[KEY];
  await rt?.close();
}
