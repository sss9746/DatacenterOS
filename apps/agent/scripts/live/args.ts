// CLI argument parsing + target safety rules for the R5 live recovery harness. Pure: no I/O.
//
//   --db <name>            REQUIRED. The SpacetimeDB database to test against (e.g. dcos-dev).
//                          `dcos` is production: refused unless --i-know-this-is-prod, and a reset is
//                          refused on prod no matter what (SCOPE §6: never default a destructive test to prod).
//   --case L1|..|L6|all    which case(s) to run (default all)
//   --seed 42  --speed 2  --timeout-s 240  --out <dir>  --run-id run-demo-1
//   --no-llm               spawn the agent without NIM credentials: a DETERMINISTIC rehearsal, labeled as such
//   --skip-reset           run against whatever run is live (only way to run on prod; cases may fail)

export const CASE_IDS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'] as const;
export type CaseId = (typeof CASE_IDS)[number];

export const PROD_DB = 'dcos';
export const DEFAULT_RUN_ID = 'run-demo-1';
export const DEFAULT_PRESET_ID = 'gpu_demo_8';
export const DEFAULT_SEED = 42;
export const DEFAULT_SPEED = 2;
export const DEFAULT_TIMEOUT_S = 240;

export interface HarnessArgs {
  readonly db: string;
  readonly cases: readonly CaseId[];
  readonly seed: number;
  readonly speed: number;
  readonly timeoutS: number;
  readonly outDir: string | null;
  readonly runId: string;
  readonly presetId: string;
  readonly noLlm: boolean;
  readonly skipReset: boolean;
  readonly acknowledgedProd: boolean;
  readonly help: boolean;
}

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgsError';
  }
}

export const USAGE = `usage: live-recovery-test --db <name> [--case L1|L2|L3|L4|L5|L6|all] [--seed 42] [--speed 2]
                          [--timeout-s 240] [--out <dir>] [--run-id run-demo-1] [--no-llm] [--skip-reset]
                          [--i-know-this-is-prod]
  --db is required and must name a disposable dev/local database. '${PROD_DB}' (prod) is refused unless
  --i-know-this-is-prod is also given, and even then the reset is refused (pass --skip-reset).`;

const num = (flag: string, raw: string | undefined, pred: (n: number) => boolean, what: string): number => {
  if (raw === undefined) throw new ArgsError(`${flag} needs a value`);
  const n = Number(raw);
  if (!Number.isFinite(n) || !pred(n)) throw new ArgsError(`${flag} must be ${what}, got "${raw}"`);
  return n;
};

export function parseCases(raw: string): CaseId[] {
  if (raw === 'all') return [...CASE_IDS];
  const out: CaseId[] = [];
  for (const part of raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) {
    if (!(CASE_IDS as readonly string[]).includes(part)) throw new ArgsError(`unknown case "${part}" (expected ${CASE_IDS.join('|')}|all)`);
    if (!out.includes(part as CaseId)) out.push(part as CaseId);
  }
  if (out.length === 0) throw new ArgsError('--case needs at least one case');
  return out;
}

export function parseArgs(argv: readonly string[]): HarnessArgs {
  let db: string | undefined;
  let cases: CaseId[] = [...CASE_IDS];
  let seed = DEFAULT_SEED;
  let speed = DEFAULT_SPEED;
  let timeoutS = DEFAULT_TIMEOUT_S;
  let outDir: string | null = null;
  let runId = DEFAULT_RUN_ID;
  let presetId = DEFAULT_PRESET_ID;
  let noLlm = false;
  let skipReset = false;
  let acknowledgedProd = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = () => argv[i + 1];
    const take = (): string | undefined => {
      i += 1;
      return argv[i];
    };
    switch (a) {
      case '--db':
        db = take();
        if (!db) throw new ArgsError('--db needs a database name');
        break;
      case '--case':
        cases = parseCases(take() ?? '');
        break;
      case '--seed':
        seed = num('--seed', take(), (n) => Number.isInteger(n) && n >= 0, 'a non-negative integer');
        break;
      case '--speed':
        speed = num('--speed', take(), (n) => n > 0 && n <= 10, 'in (0, 10]');
        break;
      case '--timeout-s':
        timeoutS = num('--timeout-s', take(), (n) => n >= 10 && n <= 3600, 'in [10, 3600] seconds');
        break;
      case '--out':
        outDir = take() ?? null;
        if (!outDir) throw new ArgsError('--out needs a directory');
        break;
      case '--run-id':
        runId = take() ?? '';
        if (!runId) throw new ArgsError('--run-id needs a value');
        break;
      case '--preset':
        presetId = take() ?? '';
        if (!presetId) throw new ArgsError('--preset needs a value');
        break;
      case '--no-llm':
        noLlm = true;
        break;
      case '--skip-reset':
        skipReset = true;
        break;
      case '--i-know-this-is-prod':
        acknowledgedProd = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        if (a.startsWith('--') && a.includes('=')) {
          // --flag=value form
          const eq = a.indexOf('=');
          return parseArgs([...argv.slice(0, i), a.slice(0, eq), a.slice(eq + 1), ...argv.slice(i + 1)]);
        }
        throw new ArgsError(`unknown argument "${a}"${next() === undefined ? '' : ''}\n${USAGE}`);
    }
  }
  if (help) return { db: db ?? '', cases, seed, speed, timeoutS, outDir, runId, presetId, noLlm, skipReset, acknowledgedProd, help };
  if (!db) throw new ArgsError(`--db is required\n${USAGE}`);
  return { db, cases, seed, speed, timeoutS, outDir, runId, presetId, noLlm, skipReset, acknowledgedProd, help };
}

export const isProdDb = (db: string): boolean => db.trim().toLowerCase() === PROD_DB;

export interface TargetPolicy {
  readonly db: string;
  readonly isProd: boolean;
  /** False on prod, always. */
  readonly resetAllowed: boolean;
  /** Whether this run will actually reset (resetAllowed && !skipReset). */
  readonly willReset: boolean;
}

/**
 * Decide whether the harness may touch `args.db`. Throws ArgsError when:
 *  - db is prod and --i-know-this-is-prod was not given;
 *  - db is prod and a reset would be needed (prod is never reset by this harness; pass --skip-reset).
 */
export function resolveTarget(args: Pick<HarnessArgs, 'db' | 'skipReset' | 'acknowledgedProd'>): TargetPolicy {
  const prod = isProdDb(args.db);
  if (prod && !args.acknowledgedProd) {
    throw new ArgsError(`refusing to run against production database '${args.db}'. Use a disposable dev/local database (e.g. dcos-dev). ` +
      `If you really mean prod, add --i-know-this-is-prod AND --skip-reset (prod is never reset by this harness).`);
  }
  if (prod && !args.skipReset) {
    throw new ArgsError(`refusing to RESET production database '${args.db}'. Add --skip-reset to run observation-only against the live run (cases may fail).`);
  }
  return { db: args.db, isProd: prod, resetAllowed: !prod, willReset: !prod && !args.skipReset };
}
