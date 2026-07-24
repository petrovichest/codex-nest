import type { ClaudeManagementStatus } from "@codexnest/protocol";

import type { ClaudeProbeResult } from "./backend";

export interface ClaudeManagerOptions {
  /** Configured Claude Code binary path, surfaced in the settings card. */
  path: string;
  /** Reads the backend's latest probe outcome without re-running it. */
  currentStatus: () => ClaudeProbeResult;
  /** Forces a fresh version probe (the backend updates its own connection state). */
  probe: () => Promise<ClaudeProbeResult>;
}

/**
 * Status source for the Claude settings card. It owns no probe logic of its own —
 * it reads and re-triggers the ClaudeBackend probe so both share one source of truth.
 */
export class ClaudeManager {
  constructor(private readonly options: ClaudeManagerOptions) {}

  status(): ClaudeManagementStatus {
    return this.toStatus(this.options.currentStatus());
  }

  async check(): Promise<ClaudeManagementStatus> {
    return this.toStatus(await this.options.probe());
  }

  private toStatus(probe: ClaudeProbeResult): ClaudeManagementStatus {
    return {
      supported: true,
      unavailableReason: probe.unavailableReason,
      cliVersion: probe.version,
      path: this.options.path,
    };
  }
}
