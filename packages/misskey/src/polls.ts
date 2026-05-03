import {
  ActivityPlugError,
  type AdapterOperationContext,
  type AuthSession,
  type Poll,
  type VotePollInput,
} from "@activityplug/core";

import { noteFromResponse } from "./internals.js";
import { clientFor, requestJson, requestVoid, tokenHeader } from "./transport.js";
import { type MisskeyAdapterOptions, type MisskeyNoteResponse } from "./types.js";

export async function getPoll(
  id: string,
  session: AuthSession | undefined,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
  operation = "poll.get",
): Promise<Poll> {
  const noteId = id.endsWith(":poll") ? id.slice(0, -":poll".length) : id;
  const note = await getNote(noteId, session, context, options, operation);
  if (note.poll === undefined) {
    throw new ActivityPlugError("NOT_FOUND", "Misskey note poll was not found.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  return note.poll;
}

export async function votePoll(
  input: VotePollInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Poll> {
  const noteId = input.pollId.endsWith(":poll")
    ? input.pollId.slice(0, -":poll".length)
    : input.pollId;
  const poll = await getPoll(input.pollId, input.session, context, options, "poll.vote");
  if (!poll.multiple && input.choices.length > 1) {
    throw new ActivityPlugError("VALIDATION_FAILED", "This Misskey poll accepts one choice.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "poll.vote",
    });
  }
  if (input.choices.some((choice) => choice >= poll.options.length)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Misskey poll choice is out of range.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "poll.vote",
    });
  }
  await Promise.all(
    input.choices.map(async (choice) =>
      requestVoid(
        clientFor(context, options)
          .post("api/notes/polls/vote", {
            headers: await tokenHeader(input.session, context, "poll.vote"),
            json: { noteId, choice },
          })
          .then(() => undefined),
        "poll.vote",
        context,
      ),
    ),
  );
  const note = await getNote(noteId, input.session, context, options, "poll.vote");
  if (note.poll === undefined) {
    throw new ActivityPlugError("NOT_FOUND", "Misskey note poll was not found.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "poll.vote",
    });
  }
  return note.poll;
}

async function getNote(
  id: string,
  session: AuthSession | undefined,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
  operation = "post.get",
) {
  const response = await requestJson<MisskeyNoteResponse>(
    clientFor(context, options)
      .post("api/notes/show", {
        ...(session === undefined
          ? {}
          : { headers: await tokenHeader(session, context, operation) }),
        json: { noteId: id },
      })
      .json(),
    operation,
    context,
  );
  return noteFromResponse(response, context, operation);
}
