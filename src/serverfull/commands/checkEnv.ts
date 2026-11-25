/**
 * @file checkEnv.ts
 * @description Validates and coordinates runtime execution across Node.js and Bun engines.
 */

import { spawnSync, spawn } from 'node:child_process';
import { formatDiagnostic } from '../format';

export type RuntimePreference = 'auto' | 'node' | 'bun';

export interface RuntimeProbeResult {
  executable: string;
  version: string;
  compatible: boolean;
}

export interface RuntimeSwitchOptions {
  /** Configured worker count from CLI (`-w, --workers`). */
  workers?: string;
  /** Override active versions map for deterministic unit testing. */
  versions?: Record<string, string | undefined>;
  /** Override process argv slice (default: process.argv.slice(1)). */
  argv?: string[];
  /** Override environment lookup for deterministic unit testing. */
  env?: Record<string, string | undefined>;
  /** Override runtime binary resolver for deterministic unit testing. */
  probeBinary?: (runtime: 'bun' | 'node') => RuntimeProbeResult | null;
}

export interface RuntimeSwitchPlan {
  action: 'keep' | 'switch';
  currentRuntime: 'node' | 'bun';
  targetPreference: RuntimePreference;
  executable?: string;
  cleanArgs?: string[];
  reason: string;
  warningMessage?: string;
  infoMessage?: string;
}

const MIN_BUN_MAJOR = 1;
const MIN_BUN_MINOR = 4;

/**
 * Checks whether a Bun semver string meets the minimum requirement (>= 1.4.0 for node:sqlite).
 *
 * @param versionStr - Raw version output from `bun --version` or `process.versions.bun`.
 * @returns True if version is >= 1.4.0.
 */
export function isCompatibleBunVersion(versionStr: string): boolean {
  const cleaned = versionStr.trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = cleaned.split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1] ?? '0');
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > MIN_BUN_MAJOR || (major === MIN_BUN_MAJOR && minor >= MIN_BUN_MINOR);
}

/**
 * Validates that the active Node.js or Bun runtime version meets minimum requirements.
 * Exits with code 1 and user-friendly diagnostics if requirements are not met.
 */
export function checkNodeVersion(): void {
  const bunVersion = (process.versions as Record<string, string | undefined>).bun;
  if (bunVersion) {
    if (!isCompatibleBunVersion(bunVersion)) {
      console.error(formatDiagnostic({
        level: 'error',
        title: 'DNS Worker - Environment Error',
        message: `Bun >= 1.4.0 is required for built-in node:sqlite support (found Bun v${bunVersion}).`,
        solutions: [
          'Please upgrade Bun to version 1.4.0 or higher.',
          'Alternatively, run with Node.js >= 22.5.0 using --runtime node.'
        ]
      }));
      process.exit(1);
    }
    return;
  }

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(formatDiagnostic({
      level: 'error',
      title: 'DNS Worker - Environment Error',
      message: `Node.js >= 22.5.0 is required (found v${process.versions.node}).`,
      solutions: [
        'Please upgrade Node.js to version 22.5.0 or higher to use built-in SQLite (node:sqlite), or install Bun >= 1.4.0.'
      ]
    }));
    process.exit(1);
  }
}

/**
 * Returns a human-friendly description of the currently active JavaScript runtime engine.
 *
 * @returns e.g. "Bun v1.4.5 (JavaScriptCore)" or "Node.js v24.2.0 (V8)"
 */
export function getActiveRuntimeDescription(): string {
  const bunVersion = (process.versions as Record<string, string | undefined>).bun;
  if (bunVersion) {
    return `Bun v${bunVersion} (JavaScriptCore)`;
  }
  return `Node.js v${process.versions.node} (V8)`;
}

/**
 * Strips `--runtime` and `--runtime=<val>` tokens cleanly from argument lists before re-spawning.
 *
 * @param args - Argument vector excluding node/bun executable (i.e. `process.argv.slice(1)`).
 * @returns Cleaned argument list.
 */
export function stripRuntimeFlags(args: string[]): string[] {
  const cleaned: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--runtime') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        i++;
      }
      continue;
    }
    if (arg.startsWith('--runtime=')) {
      continue;
    }
    cleaned.push(arg);
  }
  return cleaned;
}

/**
 * Probes PATH for the requested runtime command (`'bun'` or `'node'`), matching standard CLI resolution
 * without invoking hardcoded absolute installation paths.
 *
 * @param runtime - Target runtime command ('bun' or 'node').
 * @returns Probe metadata if executable is available in PATH, otherwise null.
 */
export function probeRuntimeBinary(runtime: 'bun' | 'node'): RuntimeProbeResult | null {
  try {
    const check = spawnSync(runtime, ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (check.status === 0 && check.stdout) {
      const version = check.stdout.trim().replace(/^v/i, '');
      const compatible = runtime === 'bun'
        ? isCompatibleBunVersion(version)
        : (() => {
            const [maj, min] = version.split('.').map(Number);
            return Number.isFinite(maj) && (maj > 22 || (maj === 22 && (min ?? 0) >= 5));
          })();
      return {
        executable: runtime,
        version,
        compatible
      };
    }
  } catch {
    // Runtime command not available in PATH
  }

  return null;
}

/**
 * Resolves the progressive runtime switching plan without executing side effects.
 * Strategy:
 * - Default ('auto' or unset): prefer Bun >= 1.4.0 when running under Node (unless multi-worker cluster > 1 is explicitly requested), falling back transparently to Node.js if Bun is unavailable or incompatible.
 * - Explicit '--runtime node' / 'DNS_WORKER_RUNTIME=node': enforce Node.js (switches if currently on Bun, stays if on Node).
 * - Explicit '--runtime bun' / 'DNS_WORKER_RUNTIME=bun': switch to Bun >= 1.4.0 if currently on Node, warn & fall back to Node.js if unavailable.
 *
 * @param requestedRuntime - Optional CLI runtime flag ('auto' | 'node' | 'bun').
 * @param options - Optional context overrides for workers and testing.
 * @returns Deterministic switch plan.
 */
export function resolveRuntimeSwitchPlan(
  requestedRuntime?: string,
  options: RuntimeSwitchOptions = {}
): RuntimeSwitchPlan {
  const env = options.env ?? process.env;
  const versions = options.versions ?? (process.versions as Record<string, string | undefined>);
  const isCurrentBun = Boolean(versions.bun);
  const currentRuntime: 'node' | 'bun' = isCurrentBun ? 'bun' : 'node';

  const rawTarget = (requestedRuntime || env.DNS_WORKER_RUNTIME || env.SERVERFULL_RUNTIME || 'auto')
    .toLowerCase()
    .trim();

  let targetPreference: RuntimePreference = 'auto';
  if (rawTarget === 'node' || rawTarget === 'bun' || rawTarget === 'auto') {
    targetPreference = rawTarget;
  }

  if (env.DNS_WORKER_SWITCHED_RUNTIME === '1') {
    return {
      action: 'keep',
      currentRuntime,
      targetPreference,
      reason: 'already-switched'
    };
  }

  if (rawTarget !== '' && rawTarget !== 'auto' && rawTarget !== 'node' && rawTarget !== 'bun') {
    return {
      action: 'keep',
      currentRuntime,
      targetPreference: 'auto',
      reason: 'unknown-runtime',
      warningMessage: `[Runtime] Unknown runtime "${rawTarget}" requested (expected auto, node, or bun). Continuing with ${isCurrentBun ? 'Bun' : 'Node.js'}.`
    };
  }

  const probe = options.probeBinary ?? probeRuntimeBinary;
  const argv = options.argv ?? process.argv.slice(1);
  const cleanArgs = stripRuntimeFlags(argv);

  // Explicit Node.js override: stay on Node or hand back from Bun to Node
  if (targetPreference === 'node') {
    if (!isCurrentBun) {
      return { action: 'keep', currentRuntime, targetPreference, reason: 'already-node' };
    }
    const nodeProbe = probe('node');
    if (nodeProbe) {
      return {
        action: 'switch',
        currentRuntime,
        targetPreference,
        executable: nodeProbe.executable,
        cleanArgs,
        reason: 'explicit-node-from-bun'
      };
    }
    return {
      action: 'keep',
      currentRuntime,
      targetPreference,
      reason: 'node-unavailable',
      warningMessage: '[Runtime] Node.js runtime was requested (--runtime node), but node binary was not found in PATH. Continuing with Bun.'
    };
  }

  // Respect explicit multi-worker clustering in auto mode under Node (Bun currently disables cluster IPC)
  const rawWorkers = (options.workers ?? env.SERVERFULL_WORKERS ?? '').trim().toLowerCase();
  const explicitMultiWorker = rawWorkers !== '' && rawWorkers !== '1' && rawWorkers !== '0';
  if (targetPreference === 'auto' && !isCurrentBun && explicitMultiWorker) {
    return {
      action: 'keep',
      currentRuntime,
      targetPreference,
      reason: 'multi-worker-node-preferred'
    };
  }

  // Target is 'bun' or 'auto': if already running on Bun, keep it; if running on Node, attempt handoff to Bun >= 1.4.0
  if (isCurrentBun) {
    return {
      action: 'keep',
      currentRuntime,
      targetPreference,
      reason: 'already-bun'
    };
  }

  const bunProbe = probe('bun');
  if (bunProbe && bunProbe.compatible) {
    return {
      action: 'switch',
      currentRuntime,
      targetPreference,
      executable: bunProbe.executable,
      cleanArgs,
      reason: targetPreference === 'bun' ? 'explicit-bun' : 'auto-prefer-bun',
      infoMessage: targetPreference === 'auto'
        ? `[Runtime] Auto-selected Bun v${bunProbe.version} (use --runtime node to force Node.js).`
        : undefined
    };
  }

  if (bunProbe && !bunProbe.compatible) {
    const msg = `[Runtime] Found Bun v${bunProbe.version} (< ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}.0; node:sqlite requires >= 1.4.0). Falling back to Node.js.`;
    return {
      action: 'keep',
      currentRuntime,
      targetPreference,
      reason: 'bun-outdated-fallback-node',
      warningMessage: targetPreference === 'bun' ? msg : undefined,
      infoMessage: targetPreference === 'auto' ? msg : undefined
    };
  }

  return {
    action: 'keep',
    currentRuntime,
    targetPreference,
    reason: 'bun-missing-fallback-node',
    warningMessage: targetPreference === 'bun'
      ? '[Runtime] Bun runtime was requested (--runtime bun), but a compatible bun binary was not found. Continuing with Node.js.'
      : undefined
  };
}

/**
 * Handles progressive/explicit runtime switching across Node.js and Bun.
 * Defaults to preferring Bun (>= 1.4.0) with automatic Node.js fallback if Bun is absent, outdated, or fails to launch.
 * Returns true if a child runtime was spawned (in which case the current process should yield).
 *
 * @param requestedRuntime - Optional runtime flag from CLI ('auto' | 'node' | 'bun').
 * @param options - Optional context such as configured CLI `--workers`.
 * @returns True if child process was spawned to take over.
 */
export function handleRuntimeSwitch(requestedRuntime?: string, options?: RuntimeSwitchOptions): boolean {
  const plan = resolveRuntimeSwitchPlan(requestedRuntime, options);

  if (plan.warningMessage) {
    console.warn(plan.warningMessage);
  } else if (plan.infoMessage && plan.action !== 'switch') {
    console.info(plan.infoMessage);
  }

  if (plan.action !== 'switch' || !plan.executable || !plan.cleanArgs) {
    return false;
  }

  try {
    const child = spawn(plan.executable, plan.cleanArgs, {
      stdio: 'inherit',
      env: { ...process.env, DNS_WORKER_SWITCHED_RUNTIME: '1' }
    });

    if (!child.pid) {
      console.warn('[Runtime] Child runtime failed to spawn PID; falling back to current runtime.');
      return false;
    }

    // Forward termination signals from parent wrapper (e.g. systemd MainPID) to child runtime so graceful shutdown runs cleanly
    const forwardSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const sig of forwardSignals) {
      process.on(sig, () => {
        try {
          if (!child.killed) {
            child.kill(sig);
          }
        } catch {
          // Ignore if child already exited
        }
      });
    }

    child.on('error', (err) => {
      console.warn(`[Runtime] Failed to execute ${plan.executable}: ${err.message}.`);
    });

    child.on('exit', (code, signal) => {
      if (signal) process.exit(128);
      else process.exit(code ?? 0);
    });

    return true;
  } catch {
    console.warn(`[Runtime] Failed to invoke ${plan.executable}. Falling back to current runtime.`);
    return false;
  }
}
