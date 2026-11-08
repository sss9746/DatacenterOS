// Thrown when a lane's real package (P1 @dcos/physics GPU functions, P2 @dcos/db-client) is not available
// yet. main.ts turns it into a friendly message + exit code 3 and points at the local demo instead.

export class AdapterNotReadyError extends Error {
  /** Which package is missing (for the friendly message). */
  readonly packageName: string;
  constructor(packageName: string, message: string) {
    super(message);
    this.name = 'AdapterNotReadyError';
    this.packageName = packageName;
  }
}

export const isAdapterNotReady = (e: unknown): e is AdapterNotReadyError => e instanceof AdapterNotReadyError;

/** Dynamic importer (injectable for tests). A variable specifier keeps tsc from resolving the package. */
export type Importer = (specifier: string) => Promise<Record<string, unknown>>;

export const defaultImporter: Importer = (specifier) => import(specifier) as Promise<Record<string, unknown>>;

/** True for "package not installed / not resolvable" errors from Node's ESM loader. */
export function isModuleNotFound(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /Cannot find (module|package)/i.test(msg);
}

/** Names in `required` that are not functions on `mod`. */
export function missingFunctions(mod: Record<string, unknown> | null | undefined, required: readonly string[]): string[] {
  return required.filter((name) => typeof mod?.[name] !== 'function');
}
