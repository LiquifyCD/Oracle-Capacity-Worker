import { safeLog } from "./safe-log";

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
      (url.pathname === "/run" || url.pathname === "/reset")
    ) {
      if (!(await authorized(request, env.ADMIN_TOKEN))) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (url.pathname === "/reset") {
        return json(await coordinator(env).reset());
      }
      return json(await coordinator(env).run("manual"));
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
