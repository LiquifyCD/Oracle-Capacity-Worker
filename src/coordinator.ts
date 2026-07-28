import { DurableObject } from "cloudflare:workers";
import { DiscordNotifier } from "./discord";
import { defaultState, DeploymentEngine, RunGate } from "./engine";
import { OciResourceManagerClient } from "./oci-client";
import { safeLog } from "./safe-log";
import type { AutomationState, RunResult, StatePort } from "./types";

export interface CoordinatorStatus {
  terminalSuccess: boolean;
  successNotified: boolean;
  retryCount: number;
  lastLifecycleState?: string;
  lastCapacityFailureAt?: number;
  pausedUntil?: number;
  leaseActive: boolean;
  updatedAt: number;
}

function positiveSeconds(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed * 1000;
}

class SqlStatePort implements StatePort {
  constructor(private readonly ctx: DurableObjectState) {}

  async load(): Promise<AutomationState> {
    const row = this.ctx.storage.sql
      .exec<{ json: string }>("SELECT json FROM automation_state WHERE id = 1")
      .toArray()[0];
    if (!row) {
      const state = defaultState(Date.now());
      await this.save(state);
      return state;
    }
    try {
      return JSON.parse(row.json) as AutomationState;
    } catch {
      safeLog("error", "state_parse_failed");
      return defaultState(Date.now());
    }
  }

  async save(state: AutomationState): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO automation_state (id, json)
       VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      JSON.stringify(state),
    );
  }
}

export class DeploymentCoordinator extends DurableObject<Env> {
  private readonly gate = new RunGate();
  private readonly statePort: StatePort;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.statePort = new SqlStatePort(ctx);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS automation_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          json TEXT NOT NULL
        )`,
      );
    });
  }

  run(trigger: "cron" | "manual"): Promise<RunResult> {
    return this.gate.run(() => this.createEngine().run(trigger));
  }

  async status(): Promise<CoordinatorStatus> {
    const state = await this.statePort.load();
    const now = Date.now();
    return {
      terminalSuccess: state.terminalSuccess,
      successNotified: state.successNotified,
      retryCount: state.retryCount,
      ...(state.lastLifecycleState
        ? { lastLifecycleState: state.lastLifecycleState }
        : {}),
      ...(state.lastCapacityFailureAt
        ? { lastCapacityFailureAt: state.lastCapacityFailureAt }
        : {}),
      ...(state.pauseUntil ? { pausedUntil: state.pauseUntil } : {}),
      leaseActive: Boolean(state.leaseUntil && state.leaseUntil > now),
      updatedAt: state.updatedAt,
    };
  }

  async reset(): Promise<CoordinatorStatus> {
    await this.statePort.save(defaultState(Date.now()));
    safeLog("warn", "coordinator_reset");
    return this.status();
  }

  private createEngine(): DeploymentEngine {
    const oci = new OciResourceManagerClient({
      region: this.env.OCI_REGION,
      stackId: this.env.OCI_STACK_OCID,
      stackLabel: this.env.STACK_LABEL,
      credentials: {
        tenancyId: this.env.OCI_TENANCY_OCID,
        userId: this.env.OCI_USER_OCID,
        fingerprint: this.env.OCI_KEY_FINGERPRINT,
        privateKeyPem: this.env.OCI_PRIVATE_KEY,
      },
    });
    const discord = new DiscordNotifier(
      this.env.DISCORD_WEBHOOK_URL,
      this.env.STACK_LABEL,
      this.env.OCI_REGION,
      this.env.DISCORD_SUCCESS_USER_ID,
    );
    return new DeploymentEngine(this.statePort, oci, discord, {
      leaseMilliseconds: positiveSeconds(this.env.LEASE_SECONDS, "LEASE_SECONDS"),
      errorCooldownMilliseconds: positiveSeconds(
        this.env.ERROR_COOLDOWN_SECONDS,
        "ERROR_COOLDOWN_SECONDS",
      ),
    });
  }
}
