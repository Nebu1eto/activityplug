import { configureServerLogging } from "@activityplug/server";
import { getRequestListener } from "@hono/node-server";
import { type Plugin, type ViteDevServer } from "vite";

import { createProductServer, type ProductServerRuntime } from "./src/server.js";

/**
 * Runs the ActivityPlug product server inside the Vite dev server.
 *
 * The browser API and the frontend then share one origin, which is what the
 * browser boundary requires: `ACTIVITYPLUG_PUBLIC_ORIGIN` must equal the origin
 * the browser actually loads. Running the API on its own port makes every
 * request cross-origin and the boundary rejects it.
 */
export function productServerPlugin(): Plugin {
  let runtime: ProductServerRuntime | undefined;
  let started: Promise<ProductServerRuntime> | undefined;
  return {
    name: "activityplug-product-server",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      // Vite may pick another port when the configured one is taken, so the
      // public origin is resolved once the listener reports its address.
      const ready = async (): Promise<ProductServerRuntime> => {
        started ??= (async () => {
          await configureServerLogging();
          runtime = await createProductServer(productServerEnvironment(server));
          return runtime;
        })();
        return started;
      };
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "/";
        if (!url.startsWith("/v1/browser") && !url.startsWith("/health")) {
          next();
          return;
        }
        void ready().then(
          (product) => getRequestListener(product.app.fetch)(request, response),
          (error: unknown) => next(error),
        );
      });
      server.httpServer?.once("close", () => {
        void runtime?.close();
      });
    },
    async closeBundle() {
      await runtime?.close();
      runtime = undefined;
      started = undefined;
    },
  };
}

/**
 * Derives the product-server environment from the dev-server configuration.
 *
 * Explicit variables always win. The defaults only cover what a local run
 * needs: in-memory storage, a per-run signing key, and the dev-server origin.
 */
function productServerEnvironment(
  server: ViteDevServer,
): Readonly<Record<string, string | undefined>> {
  const { env } = process;
  return {
    ...env,
    ACTIVITYPLUG_STORAGE: env["ACTIVITYPLUG_STORAGE"] ?? "memory",
    ACTIVITYPLUG_PUBLIC_ORIGIN: env["ACTIVITYPLUG_PUBLIC_ORIGIN"] ?? devServerOrigin(server),
    ACTIVITYPLUG_COOKIE_SIGNING_KEY:
      env["ACTIVITYPLUG_COOKIE_SIGNING_KEY"] ?? generateDevelopmentSigningKey(),
  };
}

function devServerOrigin(server: ViteDevServer): string {
  const scheme = server.config.server.https === undefined ? "http" : "https";
  const address = server.httpServer?.address();
  const port =
    address !== null && typeof address === "object" ? address.port : server.config.server.port;
  return `${scheme}://localhost:${port ?? 5173}`;
}

function generateDevelopmentSigningKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}
