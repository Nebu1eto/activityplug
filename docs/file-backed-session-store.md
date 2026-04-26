File-backed auth session stores
===============================

ActivityPlug supports `AuthSessionStore` implementations with the same public
contract in every server deployment. The default development implementation is
`InMemoryAuthSessionStore`. Production deployments should use a networked store
such as Redis or PostgreSQL.

A file-backed auth session store is not recommended. Auth sessions contain
remote access tokens, refresh tokens, origin metadata, and account identifiers.
Plain files make rotation, access control, backups, concurrent writes, and
incident response harder than a dedicated session backend.

File storage can still be useful for local experiments, single-user prototypes,
or offline integration tests. If it is added later, it must implement the same
`AuthSessionStore` contract, reject unsafe file permissions where possible, and
document that it is not a production default.
