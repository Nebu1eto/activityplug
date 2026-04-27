import { createActivityPlugClient, type Account, type AuthSession } from "@activityplug/core";
import { createMastodonAdapter } from "@activityplug/mastodon";
import { createMisskeyAdapter } from "@activityplug/misskey";

export type BotAdapter = "mastodon" | "misskey";

export interface CreateBotClientInput {
  readonly adapter: BotAdapter;
  readonly origin: string;
  readonly accessToken: string;
  readonly scopes?: readonly string[];
}

export interface BotClient {
  readonly session: AuthSession;
  readonly verifyViewer: () => Promise<Account>;
}

export async function createBotClient(input: CreateBotClientInput): Promise<BotClient> {
  const client = createActivityPlugClient({
    adapter: input.adapter === "mastodon" ? createMastodonAdapter() : createMisskeyAdapter(),
    origin: input.origin,
  });
  const session = await client.auth.injectToken({
    accessToken: input.accessToken,
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
  });
  return {
    session,
    verifyViewer: async () => (await client.auth.verifyCredentials(session)).account,
  };
}
