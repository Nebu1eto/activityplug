export type HackersPubAdapterOptions = Readonly<Record<string, never>>;

export interface HackersPubActor {
  readonly id?: string;
  readonly uuid?: string;
  readonly iri?: string;
  readonly username?: string;
  readonly handle?: string;
  readonly rawName?: string | null;
  readonly name?: string | null;
  readonly bio?: string | null;
  readonly avatarUrl?: string;
  readonly headerUrl?: string | null;
  readonly automaticallyApprovesFollowers?: boolean;
  readonly url?: string | null;
  readonly published?: string | null;
  readonly created?: string;
  readonly fields?: readonly { readonly name?: string; readonly value?: string }[];
  readonly viewerFollows?: boolean;
  readonly followsViewer?: boolean;
  readonly viewerBlocks?: boolean;
}

export interface HackersPubPost {
  readonly __typename?: string;
  readonly id?: string;
  readonly uuid?: string;
  readonly iri?: string;
  readonly url?: string | null;
  readonly actor?: HackersPubActor;
  readonly content?: string | null;
  readonly summary?: string | null;
  readonly visibility?: string;
  readonly sensitive?: boolean | null;
  readonly published?: string;
  readonly media?: readonly HackersPubPostMedium[];
  readonly poll?: HackersPubPoll | null;
  readonly replyTarget?: HackersPubPost | null;
  readonly quotedPost?: HackersPubPost | null;
  readonly sharedPost?: HackersPubPost | null;
}

export interface HackersPubPostMedium {
  readonly id?: string;
  readonly alt?: string | null;
  readonly height?: number | null;
  readonly sensitive?: boolean;
  readonly thumbnailUrl?: string | null;
  readonly type?: string;
  readonly url?: string;
  readonly width?: number | null;
}

export interface HackersPubMediaUploadResponse {
  readonly __typename?: string;
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface HackersPubLoginChallenge {
  readonly __typename?: string;
  readonly token?: string;
  readonly created?: string;
  readonly query?: string;
}

export interface HackersPubSessionResponse {
  readonly id?: string;
}

export interface HackersPubPoll {
  readonly id?: string;
  readonly postId?: string;
  readonly ends?: string;
  readonly multiple?: boolean;
  readonly options?: readonly HackersPubPollOption[];
  readonly votes?: { readonly totalCount?: number };
  readonly voters?: { readonly totalCount?: number };
  readonly votesCount?: number;
  readonly votersCount?: number;
}

export interface HackersPubPollOption {
  readonly title?: string;
  readonly votes?: { readonly totalCount?: number };
  readonly votesCount?: number | null;
}

export interface HackersPubPostEdge {
  readonly node?: HackersPubPost | null;
}

export interface HackersPubPostConnection {
  readonly edges?: readonly HackersPubPostEdge[];
  readonly pageInfo?: {
    readonly hasNextPage?: boolean;
    readonly hasPreviousPage?: boolean;
    readonly startCursor?: string | null;
    readonly endCursor?: string | null;
  };
}

export interface HackersPubViewerAccount {
  readonly id?: string;
  readonly uuid?: string;
  readonly username?: string;
  readonly name?: string | null;
  readonly handle?: string;
  readonly bio?: string | null;
  readonly avatarUrl?: string | URL | null;
  readonly created?: string;
  readonly actor?: {
    readonly id?: string;
    readonly uuid?: string;
    readonly iri?: string | null;
    readonly url?: string | null;
  } | null;
}
