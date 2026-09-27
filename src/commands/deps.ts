/**
 * The dependency bundle every command module receives.
 *
 * Commands never construct a client, resolve an emitter, or read config directly.
 * They receive this object, which keeps them small, trivially testable, and free of
 * import-time side effects — the thing that makes a CLI slow to start and hard to
 * reason about when it is not.
 */

import type { SleeperClient } from '../core/client.js';
import type { GlobalContext } from '../output/context.js';
import type { Emitter } from '../output/emit.js';

export interface CommandDeps {
  /**
   * The shared client, constructed on first use.
   *
   * Lazy so that `sleeper --help` and `sleeper --version` never read config or
   * touch the filesystem.
   */
  client(): SleeperClient;
  /** Output emitter for the active invocation. */
  emit(): Emitter;
  /** Resolved global flags. */
  context(): GlobalContext;
  /** Full command path, e.g. `sleeper trade propose`, for JSON envelopes. */
  commandPath(): string;
}

/** Build the dependency bundle. */
export function createDeps(
  context: GlobalContext,
  emitter: Emitter,
  client: SleeperClient,
  commandPath: () => string,
): CommandDeps {
  return {
    client: () => client,
    emit: () => emitter,
    context: () => context,
    commandPath,
  };
}
