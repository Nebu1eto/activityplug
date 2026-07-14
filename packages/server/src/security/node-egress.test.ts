import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type TLSSocket } from "node:tls";
import { gzipSync } from "node:zlib";

import { createVettedFetch } from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import {
  createNodePinnedDispatcher,
  lookupNodeAddresses,
  pinnedNodeRequestOptions,
} from "./node-egress.js";

const TLS_CERTIFICATE = readFileSync(
  new URL("./test-fixtures/social-example-cert.pem", import.meta.url),
  "utf8",
);
const TLS_PRIVATE_KEY = readFileSync(
  new URL("./test-fixtures/social-example-key.pem", import.meta.url),
  "utf8",
);

function testVettedFetch(): typeof fetch {
  return createVettedFetch({
    allowPrivateNetworks: true,
    remoteStructuredBytes: 1024,
    replayBodyBytes: 1024,
    timeoutMs: 1000,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    dispatchPinned: createNodePinnedDispatcher(),
    originPolicy: { assertAllowed: async () => undefined },
  });
}

describe("lookupNodeAddresses", () => {
  it("requests and returns every DNS answer", async () => {
    const calls: unknown[] = [];
    const answers = await lookupNodeAddresses("social.example", async (hostname, options) => {
      calls.push(hostname, options);
      return [
        { address: "203.0.113.10", family: 4 },
        { address: "2001:db8::10", family: 6 },
      ];
    });

    expect(calls).toEqual(["social.example", { all: true, verbatim: true }]);
    expect(answers).toEqual([
      { address: "203.0.113.10", family: 4 },
      { address: "2001:db8::10", family: 6 },
    ]);
  });
});

describe("pinned request framing", () => {
  it("computes DELETE JSON length and rejects caller framing headers", async () => {
    const body = JSON.stringify({ account_ids: ["account-1"] });
    let received: { readonly body: string; readonly length?: string; readonly transfer?: string };
    const server = createServer((request, response) => {
      let requestBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        received = {
          body: requestBody,
          ...(request.headers["content-length"] === undefined
            ? {}
            : { length: request.headers["content-length"] }),
          ...(request.headers["transfer-encoding"] === undefined
            ? {}
            : { transfer: request.headers["transfer-encoding"] }),
        };
        response.end("deleted");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP address.");

    try {
      const response = await testVettedFetch()(`http://delete.invalid:${address.port}/accounts`, {
        method: "DELETE",
        headers: {
          "content-length": "999",
          "content-type": "application/json",
          "transfer-encoding": "gzip",
        },
        body,
      });

      expect(await response.text()).toBe("deleted");
      expect(received!).toEqual({
        body,
        length: String(new TextEncoder().encode(body).byteLength),
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("preserves computed framing and bytes across a 307 redirect", async () => {
    const body = JSON.stringify({ account_ids: ["account-1"] });
    const requests: Array<{ readonly body: string; readonly length?: string }> = [];
    const server = createServer((request, response) => {
      let requestBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        requests.push({
          body: requestBody,
          ...(request.headers["content-length"] === undefined
            ? {}
            : { length: request.headers["content-length"] }),
        });
        if (request.url === "/start") {
          response.writeHead(307, { location: "/finish" });
          response.end();
        } else {
          response.end("deleted");
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP address.");

    try {
      await expect(
        testVettedFetch()(`http://delete.invalid:${address.port}/start`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body,
        }),
      ).resolves.toMatchObject({ status: 200 });
      expect(requests).toEqual([
        { body, length: String(new TextEncoder().encode(body).byteLength) },
        { body, length: String(new TextEncoder().encode(body).byteLength) },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});

describe("createNodePinnedDispatcher", () => {
  it("connects to the numeric address while preserving the HTTP Host", async () => {
    let host = "";
    const server = createServer((request, response) => {
      host = request.headers.host ?? "";
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("pinned");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP address.");

    try {
      const response = await createNodePinnedDispatcher().dispatch({
        request: new Request(`http://social.invalid:${address.port}/probe?q=1`, {
          headers: { host: "attacker.invalid" },
        }),
        address: "127.0.0.1",
        family: 4,
        hostname: "social.invalid",
        servername: "social.invalid",
        hostHeader: `social.invalid:${address.port}`,
      });

      expect(await response.text()).toBe("pinned");
      expect(host).toBe(`social.invalid:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("requests identity encoding and rejects an encoded response", async () => {
    let acceptEncoding = "";
    const server = createServer((request, response) => {
      acceptEncoding = request.headers["accept-encoding"] ?? "";
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-type": "application/json",
      });
      response.end(gzipSync(JSON.stringify({ ok: true })));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP address.");

    try {
      await expect(
        createNodePinnedDispatcher().dispatch({
          request: new Request(`http://encoded.invalid:${address.port}/json`, {
            headers: { "accept-encoding": "gzip" },
          }),
          address: "127.0.0.1",
          family: 4,
          hostname: "encoded.invalid",
          servername: "encoded.invalid",
          hostHeader: `encoded.invalid:${address.port}`,
        }),
      ).rejects.toThrow("content encoding");
      expect(acceptEncoding).toBe("identity");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("rejects a compressed HTTP transfer coding", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "transfer-encoding": "gzip, chunked",
      });
      response.end(gzipSync(JSON.stringify({ ok: true })));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP address.");

    try {
      await expect(
        createNodePinnedDispatcher().dispatch({
          request: new Request(`http://encoded.invalid:${address.port}/json`),
          address: "127.0.0.1",
          family: 4,
          hostname: "encoded.invalid",
          servername: "encoded.invalid",
          hostHeader: `encoded.invalid:${address.port}`,
        }),
      ).rejects.toThrow("transfer encoding");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it.each([
    { method: "HEAD", status: 200 },
    { method: "GET", status: 304 },
  ])(
    "allows representation encoding metadata on bodyless $method $status responses",
    async ({ method, status }) => {
      const server = createServer((_request, response) => {
        response.writeHead(status, { "content-encoding": "gzip" });
        response.end();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new TypeError("Expected TCP address.");

      try {
        const response = await createNodePinnedDispatcher().dispatch({
          request: new Request(`http://metadata.invalid:${address.port}/resource`, { method }),
          address: "127.0.0.1",
          family: 4,
          hostname: "metadata.invalid",
          servername: "metadata.invalid",
          hostHeader: `metadata.invalid:${address.port}`,
        });
        expect(response.status).toBe(status);
        expect(response.body).toBeNull();
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        );
      }
    },
  );

  it("streams uploads without materializing the complete Request body", async () => {
    let received = "";
    const server = createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        received += chunk;
      });
      request.on("end", () => response.end("uploaded"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP address.");
    const request = new Request(`http://upload.invalid:${address.port}/upload`, {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed-body"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    Object.defineProperty(request, "arrayBuffer", {
      value: () => {
        throw new Error("request body was materialized");
      },
    });

    try {
      const response = await createNodePinnedDispatcher().dispatch({
        request,
        address: "127.0.0.1",
        family: 4,
        hostname: "upload.invalid",
        servername: "upload.invalid",
        hostHeader: `upload.invalid:${address.port}`,
      });

      expect(await response.text()).toBe("uploaded");
      expect(received).toBe("streamed-body");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("streams through vetted fetch without cloning the upload body", async () => {
    let received = "";
    let contentLength: string | undefined;
    let transferEncoding: string | undefined;
    const server = createServer((request, response) => {
      contentLength = request.headers["content-length"];
      transferEncoding = request.headers["transfer-encoding"];
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        received += chunk;
      });
      request.on("end", () => response.end("uploaded"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP address.");
    const clone = vi.spyOn(Request.prototype, "clone").mockImplementation(() => {
      throw new Error("request body was cloned");
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed-"));
        controller.enqueue(new TextEncoder().encode("body"));
        controller.close();
      },
    });
    const vettedFetch = createVettedFetch({
      allowPrivateNetworks: true,
      remoteStructuredBytes: 1024,
      replayBodyBytes: 4,
      timeoutMs: 1000,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      dispatchPinned: createNodePinnedDispatcher(),
      originPolicy: { assertAllowed: async () => undefined },
    });

    try {
      const response = await vettedFetch(`http://upload.invalid:${address.port}/upload`, {
        method: "POST",
        headers: { "content-length": "1", "transfer-encoding": "gzip" },
        body: source,
        duplex: "half",
      } as RequestInit);

      expect(await response.text()).toBe("uploaded");
      expect(received).toBe("streamed-body");
      expect(contentLength).toBeUndefined();
      expect(transferEncoding).toBe("chunked");
    } finally {
      clone.mockRestore();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("rejects an already-aborted request before reading or connecting", async () => {
    let pulls = 0;
    const controller = new AbortController();
    const reason = new Error("request aborted");
    controller.abort(reason);
    const request = new Request("http://unreachable.invalid/upload", {
      method: "POST",
      body: new ReadableStream({
        pull(stream) {
          pulls += 1;
          stream.enqueue(new Uint8Array([1]));
        },
      }),
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);
    await Promise.resolve();
    const pullsBeforeDispatch = pulls;

    await expect(
      createNodePinnedDispatcher().dispatch({
        request,
        address: "192.0.2.1",
        family: 4,
        hostname: "unreachable.invalid",
        servername: "unreachable.invalid",
        hostHeader: "unreachable.invalid",
      }),
    ).rejects.toBe(reason);
    expect(pulls).toBe(pullsBeforeDispatch);
  });

  it("cancels a backpressured upload when the peer responds early", async () => {
    let cancelled = false;
    const server = createServer((_request, response) => {
      response.writeHead(413);
      response.flushHeaders();
      setTimeout(() => response.end("rejected-early"), 25);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP address.");
    const request = new Request(`http://upload.invalid:${address.port}/upload`, {
      method: "POST",
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(256 * 1024));
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => undefined);
        },
      }),
      duplex: "half",
    } as RequestInit);

    try {
      const response = await createNodePinnedDispatcher().dispatch({
        request,
        address: "127.0.0.1",
        family: 4,
        hostname: "upload.invalid",
        servername: "upload.invalid",
        hostHeader: `upload.invalid:${address.port}`,
      });
      expect(await response.text()).toBe("rejected-early");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cancelled).toBe(true);
      expect(request.body?.locked).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("returns redirects to vetted fetch instead of following them", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: "http://127.0.0.1/admin" });
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP address.");

    try {
      const response = await createNodePinnedDispatcher().dispatch({
        request: new Request(`http://social.invalid:${address.port}/redirect`),
        address: "127.0.0.1",
        family: 4,
        hostname: "social.invalid",
        servername: "social.invalid",
        hostHeader: `social.invalid:${address.port}`,
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("http://127.0.0.1/admin");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("rejects protocol upgrades instead of leaving dispatch pending", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(101, { connection: "upgrade", upgrade: "websocket" });
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP address.");

    try {
      await expect(
        createNodePinnedDispatcher().dispatch({
          request: new Request(`http://social.invalid:${address.port}/upgrade`),
          address: "127.0.0.1",
          family: 4,
          hostname: "social.invalid",
          servername: "social.invalid",
          hostHeader: `social.invalid:${address.port}`,
        }),
      ).rejects.toThrow("protocol upgrades");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("builds HTTPS pinning options with TLS SNI and Host", () => {
    expect(
      pinnedNodeRequestOptions({
        request: new Request("https://social.example:8443/path?q=1"),
        address: "2001:db8::10",
        family: 6,
        hostname: "social.example",
        servername: "social.example",
        hostHeader: "social.example:8443",
      }),
    ).toMatchObject({
      hostname: "2001:db8::10",
      family: 6,
      port: 8443,
      path: "/path?q=1",
      servername: "social.example",
      headers: expect.objectContaining({
        "accept-encoding": "identity",
        host: "social.example:8443",
      }),
    });
  });

  it("performs a pinned TLS handshake with hostname verification", async () => {
    let host = "";
    let servername: string | false | null = null;
    const server = createHttpsServer(
      { cert: TLS_CERTIFICATE, key: TLS_PRIVATE_KEY },
      (request, response) => {
        host = request.headers.host ?? "";
        servername = (request.socket as TLSSocket).servername;
        response.end("secure");
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP address.");
    const dispatcher = createNodePinnedDispatcher({ trustedCa: TLS_CERTIFICATE });

    try {
      const response = await dispatcher.dispatch({
        request: new Request(`https://social.example:${address.port}/secure`),
        address: "127.0.0.1",
        family: 4,
        hostname: "social.example",
        servername: "social.example",
        hostHeader: `social.example:${address.port}`,
      });

      expect(await response.text()).toBe("secure");
      expect(servername).toBe("social.example");
      expect(host).toBe(`social.example:${address.port}`);

      await expect(
        dispatcher.dispatch({
          request: new Request(`https://wrong.example:${address.port}/secure`),
          address: "127.0.0.1",
          family: 4,
          hostname: "wrong.example",
          servername: "wrong.example",
          hostHeader: `wrong.example:${address.port}`,
        }),
      ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});
