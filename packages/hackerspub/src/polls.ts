import { type AdapterOperationContext, type Poll, type VotePollInput } from "@activityplug/core";

import { pollFromResponse } from "./mapping.js";
import { authorizationHeader, clientFor, requestJson } from "./transport.js";
import { type HackersPubAdapterOptions, type HackersPubPoll } from "./types.js";

export async function getPoll(
  id: string,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Poll> {
  const poll = await requestJson<HackersPubPoll>(
    clientFor(context, options)
      .get(`api/posts/${encodeURIComponent(id)}/poll`)
      .json(),
    context,
    "poll.get",
  );
  return pollFromResponse(poll, id, context, "poll.get");
}

export async function votePoll(
  input: VotePollInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Poll> {
  const poll = await requestJson<HackersPubPoll>(
    clientFor(context, options)
      .post(`api/posts/${encodeURIComponent(input.pollId)}/vote`, {
        headers: await authorizationHeader(input.session, context, "poll.vote"),
        json: input.choices,
      })
      .json(),
    context,
    "poll.vote",
  );
  return pollFromResponse(poll, input.pollId, context, "poll.vote");
}
