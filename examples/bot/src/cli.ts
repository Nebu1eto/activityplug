import { createBotClient, type BotAdapter } from "./index.js";
import { createNodeBotRemoteAuthority } from "./node-remote-authority.js";

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(helpText());
    return;
  }
  const adapter = envAdapter("ACTIVITYPLUG_BOT_ADAPTER");
  const origin = env("ACTIVITYPLUG_BOT_ORIGIN");
  const accessToken = env("ACTIVITYPLUG_BOT_ACCESS_TOKEN");
  const username = env("ACTIVITYPLUG_BOT_USERNAME");
  const replyText = process.env["ACTIVITYPLUG_BOT_REPLY"] ?? "Thanks for the mention.";
  const limit = optionalInteger("ACTIVITYPLUG_BOT_LIMIT") ?? 20;
  const bot = await createBotClient({
    adapter,
    origin,
    accessToken,
    scopes: scopes(),
    remoteAuthority: createNodeBotRemoteAuthority(origin),
  });
  const viewer = await bot.verifyViewer();
  const replies = await bot.handleTimelineMentions({
    username,
    limit,
    reply: () => replyText,
    acknowledgementEmoji: process.env["ACTIVITYPLUG_BOT_ACKNOWLEDGEMENT_EMOJI"],
  });
  console.log(
    JSON.stringify(
      {
        viewer: viewer.acct,
        replies: replies.map((post) => post.ref.rawId),
      },
      null,
      2,
    ),
  );
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function envAdapter(name: string): BotAdapter {
  const value = env(name);
  if (value !== "mastodon" && value !== "misskey") {
    throw new Error(`${name} must be mastodon or misskey.`);
  }
  return value;
}

function optionalInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function scopes(): readonly string[] | undefined {
  const value = process.env["ACTIVITYPLUG_BOT_SCOPES"];
  if (value === undefined || value.trim() === "") return undefined;
  return value.split(/\s+/u).filter(Boolean);
}

function helpText(): string {
  return [
    "Usage: pnpm --filter @activityplug/example-bot start",
    "",
    "Required environment variables:",
    "  ACTIVITYPLUG_BOT_ADAPTER=mastodon|misskey",
    "  ACTIVITYPLUG_BOT_ORIGIN=https://example.social",
    "  ACTIVITYPLUG_BOT_ACCESS_TOKEN=...",
    "  ACTIVITYPLUG_BOT_USERNAME=bot_username",
    "",
    "Optional environment variables:",
    '  ACTIVITYPLUG_BOT_SCOPES="read write follow"',
    '  ACTIVITYPLUG_BOT_REPLY="Thanks for the mention."',
    "  ACTIVITYPLUG_BOT_ACKNOWLEDGEMENT_EMOJI=<emoji>",
    "  ACTIVITYPLUG_BOT_LIMIT=20",
  ].join("\n");
}
