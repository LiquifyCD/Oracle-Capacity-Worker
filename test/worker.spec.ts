import { env, exports } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { AutomationState } from "../src/types";

describe("Worker endpoints and Cron routing", () => {
  it("returns a secret-free health response", async () => {
    const response = await exports.default.fetch("https://worker.test/health");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("test-stack");
    expect(body).not.toContain("test-tenancy");
    expect(body).not.toContain("discord.com");
  });

  it("rejects unauthorized manual execution", async () => {
    const response = await exports.default.fetch("https://worker.test/run", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });

    expect(response.status).toBe(401);
  });

  it("allows an authorized reset", async () => {
    const response = await exports.default.fetch("https://worker.test/reset", {
      method: "POST",
      headers: { authorization: "Bearer test-admin-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ terminalSuccess: false });
  });

  it("routes a scheduled event through the coordinator without retrying after success", async () => {
    const stub = env.DEPLOYMENT_COORDINATOR.getByName("primary");
    await runInDurableObject(stub, (_instance, state) => {
      const terminal: AutomationState = {
        terminalSuccess: true,
        successNotified: true,
        activeJobId: "redacted-test-job",
        lastLifecycleState: "SUCCEEDED",
        retryCount: 4,
        errorFingerprints: [],
        updatedAt: Date.now(),
      };
      state.storage.sql.exec(
        `INSERT INTO automation_state (id, json)
         VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
        JSON.stringify(terminal),
      );
    });
    const controller = createScheduledController({
      cron: "*/15 * * * *",
      scheduledTime: Date.now(),
    });
    const ctx = createExecutionContext();

    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);
    const status = await stub.status();

    expect(status.terminalSuccess).toBe(true);
    expect(status.retryCount).toBe(4);
  });
});
