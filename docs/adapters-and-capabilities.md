Adapters and capabilities
=========================

English | [한국어](adapters-and-capabilities.ko.md) |
[日本語](adapters-and-capabilities.ja.md)

ActivityPlug adapters translate one server family's API into a shared client
contract. The contract does not imply that every server implements every
operation. Capability decisions describe the behavior that an application can
rely on for a selected adapter and instance.


Supported server software
-------------------------

| Adapter package            | Adapter ID   | Detected software | API family                          |
| -------------------------- | ------------ | ----------------- | ----------------------------------- |
| `@activityplug/mastodon`   | `mastodon`   | Mastodon          | Mastodon                            |
| `@activityplug/pleroma`    | `pleroma`    | Pleroma, Akkoma   | Mastodon-compatible with extensions |
| `@activityplug/misskey`    | `misskey`    | Misskey           | Misskey                             |
| `@activityplug/hackerspub` | `hackerspub` | HackersPub        | GraphQL and HTTP                    |
| `@activityplug/hollo`      | `hollo`      | Hollo             | Mastodon-compatible with extensions |

`@activityplug/mastodon-base` is an implementation package for
Mastodon-compatible adapter authors. It is not a general-purpose choice for
automatic software detection because its caller supplies the adapter identity,
supported software names, and family-specific behavior.

The ActivityPlug server tests registered adapters in order when the request
does not specify an adapter. It accepts a detected profile when its software
identity matches the adapter metadata's ID, kind, or `supportedSoftware`
entries. Supplying an adapter ID selects that adapter directly and runs its
instance discovery without applying this family-name match. Discovery can
still reject malformed or otherwise incompatible responses.


Capability decisions
--------------------

Every name in `CapabilityName` resolves to a `CapabilityDecision`:

~~~~ ts
interface CapabilityDecision {
  readonly name: CapabilityName;
  readonly status: "supported" | "unsupported" | "unknown";
  readonly source: "static" | "nodeinfo" | "oauth" | "instance" | "probe";
  readonly reason?: string;
  readonly constraints?: CapabilityConstraints;
  readonly raw?: unknown;
}
~~~~

The three statuses have distinct meanings:

 -  `supported`: the selected adapter and available evidence permit the
    operation.
 -  `unsupported`: the adapter has an explicit reason not to offer the
    operation.
 -  `unknown`: the adapter cannot prove support, often because software identity
    or a stable version is unavailable.

Treat only `supported` as permission to expose an optional feature. `unknown`
is not optimistic support.

~~~~ ts
const profile = await client.instances.detect();
const decision = profile.capabilities["posts.update"];

switch (decision.status) {
  case "supported":
    // Offer editing.
    break;
  case "unsupported":
    console.log(decision.reason);
    break;
  case "unknown":
    // Hide or disable editing until support can be established.
    break;
}
~~~~

`constraints` can narrow a supported operation. For example, post creation
records accepted input forms, and a media capability can declare byte, item, or
MIME-type limits. Check these constraints before building an input that a
server cannot represent.


Static and detected layers
--------------------------

An adapter's metadata contains a complete static capability set. Missing
entries become `unknown`. ActivityPlug can merge later evidence from NodeInfo,
OAuth metadata, an instance document, or an explicit probe.

Layers are ordered by source:

~~~~ text
static < nodeinfo < oauth < instance < probe
~~~~

A non-`unknown` decision replaces an earlier `unknown` decision. An
`unknown` decision does not erase an existing supported or unsupported result.
When two decisions have the same certainty, the higher-ranked source wins.

Examples of Mastodon-compatible behavior that depends on the detected family
or version include:

 -  Mastodon status editing requires 3.5.0 or newer.
 -  Mastodon asynchronous media upload requires 3.1.3 or newer.
 -  Mastodon media deletion requires 4.4.0 or newer.
 -  Mastodon filter v2 endpoints require 4.0.0 or newer.
 -  Pleroma and Akkoma receive family-specific decisions rather than Mastodon
    version thresholds.
 -  Hollo relationship lookup requires a detected version of 0.1.0 or newer.
 -  Streaming decisions include the injected factory, discovered endpoint,
    family, version, and transport security.

The instance profile returned by detection contains the merged set. When
creating a second direct client after detection, pass both
`profile.capabilities` and `profile.software`. The ActivityPlug server performs
that handoff automatically.


Feature comparison
------------------

The following table summarizes broad adapter behavior. `Yes` means that the
adapter maps the feature group, not that every operation in the group is
unconditional. Read the effective capability set for operation-level and
version-level decisions.

| Feature group                   | Mastodon          | Pleroma/Akkoma   | Misskey               | HackersPub            | Hollo |
| ------------------------------- | ----------------- | ---------------- | --------------------- | --------------------- | ----- |
| OAuth authorization code        | Yes               | Yes              | Yes                   | No                    | Yes   |
| Token import                    | Yes               | Yes              | Yes                   | Yes                   | Yes   |
| Email challenge / passkey       | No                | No               | No                    | Both                  | No    |
| Home and public timelines       | Yes               | Yes              | Yes                   | Yes                   | Yes   |
| Lists and list timeline         | Yes               | Yes              | Yes                   | No                    | Yes   |
| Follow requests                 | Yes               | Yes              | Yes                   | No                    | Yes   |
| Post editing                    | Version-dependent | Family-dependent | No                    | No                    | Yes   |
| Quote creation                  | No                | Yes              | Yes                   | Yes                   | Yes   |
| Emoji reactions                 | No                | Yes              | Yes                   | Yes                   | Yes   |
| Media upload                    | Version-dependent | Yes              | Yes                   | Partial workflow only | Yes   |
| URL media ingestion             | No                | No               | Yes, with WebSocket   | Yes                   | No    |
| Timeline / notification streams | Yes, detected     | Yes, detected    | Yes, injected factory | No                    | No    |
| Filters                         | Version-dependent | Yes              | No                    | No                    | No    |
| Scheduled posts                 | Yes               | Yes              | No                    | No                    | No    |

The table deliberately calls HackersPub media upload a partial workflow. Its
GraphQL upload mutation can store an image, but the mapped `createNote`
mutation cannot attach that image. The portable `media.upload` capability is
therefore `unsupported`; URL ingestion remains available as a separate
operation.


Operation enforcement
---------------------

The core client checks the capability associated with a public operation before
calling the adapter. If the decision is not `supported`, the client throws an
`ActivityPlugError` with code `UNSUPPORTED_OPERATION`. The error context
includes the operation and, when applicable, the capability name.

Adapters also validate input-dependent conditions that a single capability
cannot express. Examples include:

 -  rejecting a post that combines a poll and media on Mastodon-compatible APIs;
 -  rejecting HackersPub content warnings or media attachments during post
    creation;
 -  requiring trusted Misskey version detection for authenticated WebSockets;
 -  rejecting search cursors when a remote API has no reliable cursor.

These failures are typed instead of being represented by `null`, an empty
collection, or silently altered input.


Choosing an adapter
-------------------

Use the concrete package for the software family that the application intends
to support. For a multi-instance service, register all required adapters and
let trusted detection choose among them. Do not select an adapter from an
untrusted software-name string without running the adapter's own instance
detection.

For optional UI or API behavior:

1.  obtain the effective capability set for the selected origin;
2.  require `status === "supported"`;
3.  apply any declared constraints;
4.  handle `UNSUPPORTED_OPERATION` because a remote instance can still differ
    from the evidence available during discovery.

See [streaming and media](streaming-and-media.md) for the transport-sensitive
capabilities and [errors and troubleshooting](errors-and-troubleshooting.md)
for the error model.
