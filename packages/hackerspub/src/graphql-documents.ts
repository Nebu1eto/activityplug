import { hackersPubGraphQL } from "./transport.js";
import {
  type HackersPubActor,
  type HackersPubPost,
  type HackersPubViewerAccount,
} from "./types.js";

export const searchActorsByHandleDocument = hackersPubGraphQL<
  { readonly searchActorsByHandle?: readonly HackersPubActor[] },
  { readonly prefix: string; readonly limit: number }
>(`
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

export const viewerDocument = hackersPubGraphQL<
  { readonly viewer?: HackersPubViewerAccount | null },
  Record<never, never>
>(`
  query {
    viewer {
      uuid
      username
      name
      handle
      bio
      avatarUrl
      created
    }
  }
`);

export const actorByUuidDocument = hackersPubGraphQL<
  { readonly actorByUuid?: HackersPubActor | null },
  { readonly id: string }
>(`
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

export const actorByHandleDocument = hackersPubGraphQL<
  { readonly actorByHandle?: HackersPubActor | null },
  { readonly handle: string }
>(`
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

export const deletePostDocument = hackersPubGraphQL<
  { readonly deletePost?: { readonly deletedPostId?: string } | null },
  { readonly input: { readonly id: string } }
>(`
  mutation ($input: DeletePostInput!) {
    deletePost(input: $input) {
      __typename
      ... on DeletePostPayload {
        deletedPostId
      }
    }
  }
`);

export const postGlobalIdDocument = hackersPubGraphQL<
  { readonly node?: HackersPubPost | null },
  { readonly id: string }
>(`
  query ($id: ID!) {
    node(id: $id) {
      ... on Post {
        uuid
      }
    }
  }
`);
