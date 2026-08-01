import { safeLog } from "./safe-log";
import { DiscordNotifier } from "./discord";

export { DeploymentCoordinator } from "./coordinator";

const encoder = new TextEncoder();

async function authorized(request: Request, expected: string): Promise<boolean> {
  const header = request.headers.get("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function coordinator(env: Env) {
  return env.DEPLOYMENT_COORDINATOR.getByName("primary");
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const result = await coordinator(env).run("cron");
    safeLog("info", "cron_completed", {
      cron: controller.cron,
      outcome: result.outcome,
      state: result.jobState,
    });
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(await coordinator(env).status());
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/run" || url.pathname === "/reset" || url.pathname === "/notify")
    ) {
      const expectedToken = url.pathname === "/notify" ? env.NOTIFY_TOKEN : env.ADMIN_TOKEN;
      if (!(await authorized(request, expectedToken))) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (url.pathname === "/notify") {
        let body: { event?: unknown; content?: unknown };
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        const events = ["heartbeat", "status", "failure", "success"] as const;
        if (
          typeof body.content !== "string" ||
          body.content.length < 1 ||
          body.content.length > 1000 ||
          !events.includes(body.event as (typeof events)[number])
        ) {
          return json({ error: "Invalid notification" }, 400);
        }
        const notifier = new DiscordNotifier(
          env.DISCORD_WEBHOOK_URL,
          env.STACK_LABEL,
          env.OCI_REGION,
          env.DISCORD_SUCCESS_USER_ID,
        );
        await notifier.sendCheckerEvent(
          body.event as (typeof events)[number],
          body.content,
        );
        return json({ ok: true });
      }
      if (url.pathname === "/reset") {
        return json(await coordinator(env).reset());
      }
      return json(await coordinator(env).run("manual"));
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
