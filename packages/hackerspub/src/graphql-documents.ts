import { gql, type TypedDocumentNode } from "@urql/core";

import {
  type HackersPubActor,
  type HackersPubLoginChallenge,
  type HackersPubMediaUploadResponse,
  type HackersPubPost,
  type HackersPubSessionResponse,
  type HackersPubViewerAccount,
} from "./types.js";

export const postMediumSelection = `
  id
  alt
  height
  sensitive
  thumbnailUrl
  type
  url
  width
`;

export const searchActorsByHandleDocument: TypedDocumentNode<
  { readonly searchActorsByHandle?: readonly HackersPubActor[] },
  { readonly prefix: string; readonly limit: number }
> = gql(`
  query ($prefix: String!, $limit: Int) {
    searchActorsByHandle(prefix: $prefix, limit: $limit) {
      id
      uuid
      iri
      username
      handle
      rawName
      name
      bio
      avatarUrl
      headerUrl
      automaticallyApprovesFollowers
      url
      published
      created
      fields {
        name
        value
      }
    }
  }
`);

export const viewerDocument: TypedDocumentNode<
  { readonly viewer?: HackersPubViewerAccount | null },
  Record<never, never>
> = gql(`
  query {
    viewer {
      id
      uuid
      username
      name
      handle
      bio
      avatarUrl
      created
      actor {
        id
        uuid
        iri
        url
      }
    }
  }
`);

export const actorByUuidDocument: TypedDocumentNode<
  { readonly actorByUuid?: HackersPubActor | null },
  { readonly id: string }
> = gql(`
  query ($id: UUID!) {
    actorByUuid(uuid: $id) {
      id
      uuid
      iri
      username
      handle
      rawName
      name
      bio
      avatarUrl
      headerUrl
      automaticallyApprovesFollowers
      url
      published
      created
      fields {
        name
        value
      }
    }
  }
`);

export const actorByHandleDocument: TypedDocumentNode<
  { readonly actorByHandle?: HackersPubActor | null },
  { readonly handle: string }
> = gql(`
  query ($handle: String!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      id
      uuid
      iri
      username
      handle
      rawName
      name
      bio
      avatarUrl
      headerUrl
      automaticallyApprovesFollowers
      url
      published
      created
      fields {
        name
        value
      }
    }
  }
`);

export const deletePostDocument: TypedDocumentNode<
  { readonly deletePost?: { readonly deletedPostId?: string } | null },
  { readonly input: { readonly id: string } }
> = gql(`
  mutation ($input: DeletePostInput!) {
    deletePost(input: $input) {
      __typename
      ... on DeletePostPayload {
        deletedPostId
      }
    }
  }
`);

export const postGlobalIdDocument: TypedDocumentNode<
  { readonly node?: HackersPubPost | null },
  { readonly id: string }
> = gql(`
  query ($id: ID!) {
    node(id: $id) {
      ... on Post {
        uuid
      }
    }
  }
`);

export const uploadMediaDocument: TypedDocumentNode<
  { readonly uploadMedia?: HackersPubMediaUploadResponse | null },
  { readonly input: { readonly mediaUrl: string } }
> = gql(`
  mutation ($input: UploadMediaInput!) {
    uploadMedia(input: $input) {
      __typename
      ... on UploadMediaPayload {
        url
        width
        height
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        __typename
      }
    }
  }
`);

export const createNoteDocument: TypedDocumentNode<
  { readonly createNote?: { readonly __typename?: string; readonly note?: HackersPubPost } | null },
  {
    readonly input: {
      readonly content: string;
      readonly visibility: string;
      readonly language: string;
      readonly replyTargetId?: string;
      readonly quotedPostId?: string;
    };
  }
> = gql(`
  mutation ($input: CreateNoteInput!) {
    createNote(input: $input) {
      __typename
      ... on CreateNotePayload {
        note {
          id
          uuid
          iri
          url
          content
          summary
          visibility
          sensitive
          published
          media {
            ${postMediumSelection}
          }
          replyTarget { id uuid iri url }
          quotedPost { id uuid iri url }
          sharedPost { id uuid iri url }
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
`);

export const loginByEmailDocument: TypedDocumentNode<
  { readonly loginByEmail?: HackersPubLoginChallenge | null },
  { readonly email: string; readonly locale: string; readonly verifyUrl: string }
> = gql(`
  mutation ($email: String!, $locale: Locale!, $verifyUrl: URITemplate!) {
    loginByEmail(email: $email, locale: $locale, verifyUrl: $verifyUrl) {
      __typename
      ... on LoginChallenge {
        token
        created
      }
      ... on AccountNotFoundError {
        query
      }
    }
  }
`);

export const completeLoginChallengeDocument: TypedDocumentNode<
  { readonly completeLoginChallenge?: HackersPubSessionResponse | null },
  { readonly token: string; readonly code: string }
> = gql(`
  mutation ($token: UUID!, $code: String!) {
    completeLoginChallenge(token: $token, code: $code) {
      id
    }
  }
`);

export const getPasskeyAuthenticationOptionsDocument: TypedDocumentNode<
  { readonly getPasskeyAuthenticationOptions?: unknown },
  { readonly sessionId: string }
> = gql(`
  mutation ($sessionId: UUID!) {
    getPasskeyAuthenticationOptions(sessionId: $sessionId)
  }
`);

export const loginByPasskeyDocument: TypedDocumentNode<
  { readonly loginByPasskey?: HackersPubSessionResponse | null },
  { readonly sessionId: string; readonly authenticationResponse: unknown }
> = gql(`
  mutation ($sessionId: UUID!, $authenticationResponse: JSON!) {
    loginByPasskey(sessionId: $sessionId, authenticationResponse: $authenticationResponse) {
      id
    }
  }
`);
