Local session store testing
===========================

ActivityPlug includes a Docker Compose environment for the Redis and PostgreSQL
auth session stores.

Start the local services before running integration tests:

~~~~ sh
docker compose up -d --wait redis postgres
~~~~

Run the container-backed integration tests:

~~~~ sh
pnpm test:integration
~~~~

The default endpoints are:

 -  Redis: `redis://127.0.0.1:56379`
 -  PostgreSQL:
    `postgres://activityplug:activityplug@127.0.0.1:55432/activityplug`

Override them with `ACTIVITYPLUG_REDIS_URL` and `ACTIVITYPLUG_POSTGRES_URL`
when another local environment owns those ports.
