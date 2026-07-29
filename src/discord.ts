import type { DiscordPort, OciJob, RunResult } from "./types";

function sanitize(value: string): string {
  return value
    .replace(/ocid1\.[a-z0-9._-]+/gi, "[redacted-ocid]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/Signature\s+version=.*$/gi, "[redacted-signature]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function readShortError(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const part = await reader.read();
  await reader.cancel().catch(() => undefined);
  if (part.done) return "";
  return new TextDecoder().decode(part.value.subarray(0, 2048));
}

export class DiscordNotifier implements DiscordPort {
  constructor(
    private readonly webhookUrl: string,
    private readonly stackLabel: string,
    private readonly region: string,
    private readonly successUserId: string,
    private readonly fetcher: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response> = (input, init) => fetch(input, init),
  ) {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(url.hostname)) {
      throw new Error("DISCORD_WEBHOOK_URL must use an official Discord HTTPS host");
    }
    if (!/^\d{17,20}$/.test(successUserId)) {
      throw new Error("DISCORD_SUCCESS_USER_ID must be a Discord user ID");
    }
  }

  async sendSuccess(job: OciJob): Promise<void> {
    await this.send(
      {
        title: "OCI A1 deployment succeeded",
        description: "The Resource Manager Apply job completed successfully. Automatic deployment retries are now disabled.",
        color: 0x2ecc71,
        fields: [
          { name: "Stack", value: sanitize(this.stackLabel), inline: true },
          { name: "Region", value: sanitize(this.region), inline: true },
          { name: "State", value: job.lifecycleState, inline: true },
        ],
      },
      true,
    );
  }

  async sendFailure(summary: string, fingerprint: string): Promise<void> {
    await this.send({
      title: "OCI A1 deployment needs attention",
      description: sanitize(summary),
      color: 0xe67e22,
      fields: [
        { name: "Stack", value: sanitize(this.stackLabel), inline: true },
        { name: "Region", value: sanitize(this.region), inline: true },
        { name: "Error ID", value: fingerprint.slice(0, 12), inline: true },
      ],
    });
  }

  async sendCapacityFailure(): Promise<void> {
    await this.post({
      username: "Oracle",
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: "A1 capacity unavailable",
          description: "No capacity was available. A new deployment attempt has started.",
          color: 0xf59e0b,
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendRunStatus(result: RunResult): Promise<void> {
    const statuses: Partial<
      Record<
        RunResult["outcome"],
        { title: string; description: string; color: number }
      >
    > = {
      apply_created: {
        title: "Deployment attempt started",
        description: "OCI accepted a new Apply job. It will be checked again in 15 minutes.",
        color: 0x3498db,
      },
      job_active: {
        title: "Deployment still running",
        description: `The OCI Apply job is ${result.jobState ?? "active"}. It will be checked again in 15 minutes.`,
        color: 0x3498db,
      },
      paused: {
        title: "Automation paused",
        description: "Retries are temporarily paused after an error.",
        color: 0xe67e22,
      },
      transient_error: {
        title: "Temporary OCI error",
        description: "The check could not finish. It will retry in 15 minutes.",
        color: 0xf59e0b,
      },
      lease_active: {
        title: "Check already running",
        description: "Another check is still active. No duplicate deployment was started.",
        color: 0x95a5a6,
      },
    };
    const status = statuses[result.outcome];

    if (!status) return;
    await this.post({
      username: "Oracle",
      allowed_mentions: { parse: [] },
      embeds: [{ ...status, timestamp: new Date().toISOString() }],
    });
  }

  private async send(embed: {
    title: string;
    description: string;
    color: number;
    fields: Array<{ name: string; value: string; inline: boolean }>;
  }, mentionSuccessUser = false): Promise<void> {
    const content = mentionSuccessUser ? `<@${this.successUserId}>` : undefined;
    await this.post({
      username: "Oracle",
      ...(content ? { content } : {}),
      allowed_mentions: content
        ? { parse: [], users: [this.successUserId] }
        : { parse: [] },
      embeds: [{ ...embed, timestamp: new Date().toISOString() }],
    });
  }

  private async post(payload: object): Promise<void> {
    const response = await this.fetcher(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
    });

    if (!response.ok) {
      const detail = sanitize(await readShortError(response));
      throw new Error(`Discord webhook failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
  }
}
