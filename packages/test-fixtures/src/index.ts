export const serverDiscoveryFixtures = {
  mastodon: {
    origin: "https://mastodon.example",
    nodeInfo: {
      software: { name: "mastodon", version: "4.3.0" },
      protocols: ["activitypub"],
    },
    oauthMetadata: {
      authorizationEndpoint: "https://mastodon.example/oauth/authorize",
      tokenEndpoint: "https://mastodon.example/oauth/token",
      grantTypesSupported: ["authorization_code"],
    },
    instance: {
      version: "4.3.0",
      urls: { streamingApi: "wss://mastodon.example/api/v1/streaming" },
    },
  },
  misskey: {
    origin: "https://misskey.example",
    nodeInfo: {
      software: { name: "misskey", version: "2025.10.0" },
      protocols: ["activitypub"],
    },
    oauthMetadata: {
      authorizationEndpoint: "https://misskey.example/oauth/authorize",
      tokenEndpoint: "https://misskey.example/oauth/token",
      grantTypesSupported: ["authorization_code"],
    },
    instance: {
      version: "2025.10.0",
    },
    probes: [{ name: "emoji-reactions", supported: true }],
  },
  pleroma: {
    origin: "https://pleroma.example",
    nodeInfo: {
      software: { name: "pleroma", version: "2.7.0" },
      protocols: ["activitypub"],
    },
    probes: [
      { name: "quote-posts", supported: true },
      { name: "emoji-reactions", supported: true },
    ],
  },
  hollo: {
    origin: "https://hollo.example",
    nodeInfo: {
      software: { name: "hollo", version: "0.6.0" },
      protocols: ["activitypub"],
    },
    oauthMetadata: {
      authorizationEndpoint: "https://hollo.example/oauth/authorize",
      tokenEndpoint: "https://hollo.example/oauth/token",
    },
    probes: [{ name: "streaming", supported: false, reason: "Hollo does not expose streaming." }],
  },
  hackerspub: {
    origin: "https://hackers.pub",
    nodeInfo: {
      software: { name: "hackerspub", version: "0.1.0" },
      protocols: ["activitypub"],
    },
    probes: [{ name: "oauth", supported: false, reason: "HackersPub does not use OAuth." }],
  },
} as const;
