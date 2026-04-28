import { Buffer } from "node:buffer";

import {
  ActivityPlugError,
  createEntityRef,
  type AdapterOperationContext,
  type CreatePostInput,
  type MediaAttachment,
  type Post,
  type UploadMediaInput,
} from "@activityplug/core";

import { assertMutationSuccess, postFromMutationPayload } from "./mapping.js";
import {
  activityPlugError,
  authorizationHeader,
  clientFor,
  graphql,
  isRecord,
  postFromResponse,
  requestJson,
} from "./transport.js";
import {
  type HackersPubAdapterOptions,
  type HackersPubMediaUploadResponse,
  type HackersPubPost,
} from "./types.js";

export async function createHackersPubPost(
  input: CreatePostInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Post> {
  if (input.poll !== undefined) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "HackersPub does not expose poll creation in createNote.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "post.create",
        capability: "polls.create",
      },
    );
  }
  if (input.mediaIds !== undefined && input.mediaIds.length > 0) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "HackersPub createNote does not expose media attachment input.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "post.create",
        capability: "media.upload",
      },
    );
  }
  const response = await graphql<Record<string, unknown>>(
    `
      mutation ($input: CreateNoteInput!) {
        createNote(input: $input) {
          __typename
          ... on CreateNotePayload {
            note {
              ${notePostSelection()}
            }
          }
          ... on InvalidInputError {
            inputPath
          }
          ... on NotAuthenticatedError {
            __typename
          }
        }
      }
    `,
    {
      input: {
        content: input.content,
        visibility: hackersPubVisibilityInput(input.visibility),
        language: "en",
        ...(input.replyToId === undefined
          ? {}
          : { replyTargetId: await firstPostGlobalId(input.replyToId, context, options) }),
        ...(input.quoteOfId === undefined
          ? {}
          : { quotedPostId: await firstPostGlobalId(input.quoteOfId, context, options) }),
      },
    },
    context,
    options,
    "post.create",
    input.session,
  );
  assertMutationSuccess(response["createNote"], "createNote", "post.create", context, response);
  const post = postFromMutationPayload(response, "createNote", "note", context, "post.create");
  return postFromResponse(post, context, "post.create");
}

export async function uploadHackersPubMedia(
  input: UploadMediaInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<MediaAttachment> {
  const form = new FormData();
  form.set("file", input.file, input.filename);
  const response = await requestJson<HackersPubMediaUploadResponse>(
    clientFor(context, options)
      .post("api/media", {
        headers: await authorizationHeader(input.session, context, "media.upload"),
        body: form,
      })
      .json(),
    context,
    "media.upload",
  );
  if (
    !isRecord(response) ||
    typeof response.url !== "string" ||
    (response.width !== undefined && typeof response.width !== "number") ||
    (response.height !== undefined && typeof response.height !== "number")
  ) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub media upload response is malformed.",
      context,
      "media.upload",
      response,
    );
  }
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "media",
      id: response.url,
      rawUrl: response.url,
    }),
    type: "image",
    url: response.url,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(response.width === undefined ? {} : { width: response.width }),
    ...(response.height === undefined ? {} : { height: response.height }),
    raw: response,
  };
}

function hackersPubVisibilityInput(visibility: CreatePostInput["visibility"]): string {
  if (visibility === "unlisted") return "UNLISTED";
  if (visibility === "followers") return "FOLLOWERS";
  if (visibility === "direct") return "DIRECT";
  if (visibility === "none") return "NONE";
  return "PUBLIC";
}

function notePostSelection(): string {
  return `
    id
    uuid
    iri
    url
    content
    summary
    visibility
    published
    actor {
      id
      uuid
      iri
      username
      handle
      rawName
      name
      avatarUrl
      created
    }
  `;
}

async function firstPostGlobalId(
  id: string,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<string> {
  let lastError: unknown;
  for (const type of ["Note", "Article", "Question"] as const) {
    const globalId = Buffer.from(`${type}:${id}`, "utf8").toString("base64");
    try {
      await assertPostGlobalId(globalId, context, options);
      return globalId;
    } catch (error) {
      if (!isRecoverablePostGlobalIdError(error)) throw error;
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw activityPlugError("NOT_FOUND", "HackersPub post was not found.", context, "post.create");
}

async function assertPostGlobalId(
  id: string,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<void> {
  const response = await graphql<{ readonly node?: HackersPubPost | null }>(
    `
      query ($id: ID!) {
        node(id: $id) {
          ... on Post {
            uuid
          }
        }
      }
    `,
    { id },
    context,
    options,
    "post.get",
  );
  if (response.node === null) {
    throw activityPlugError("NOT_FOUND", "HackersPub post was not found.", context, "post.get");
  }
  if (response.node === undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post response is malformed.",
      context,
      "post.get",
      response,
    );
  }
}

function isRecoverablePostGlobalIdError(error: unknown): boolean {
  return (
    error instanceof ActivityPlugError &&
    (error.code === "NOT_FOUND" ||
      error.code === "VALIDATION_FAILED" ||
      (error.code === "REMOTE_ERROR" &&
        (error.message.includes("Invalid global ID") || error.message.includes("not found"))))
  );
}
