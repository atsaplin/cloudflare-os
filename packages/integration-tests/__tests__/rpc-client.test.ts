import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { connect } from "../src/rpc-client.js";

const servers = new Set<{ http: Server; ws: WebSocketServer }>();

afterEach(async () => {
  await Promise.all([...servers].map(async ({ http, ws }) => {
    ws.close();
    http.close();
    await Promise.allSettled([once(ws, "close"), once(http, "close")]);
  }));
  servers.clear();
});

it("sends the Access application token and same-origin header on preview WebSockets", async () => {
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  servers.add({ http, ws });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");

  const address = http.address();
  if (!(address instanceof Object) || !("port" in address)) {
    throw new Error("Test server has no TCP port");
  }
  const baseUrl = new URL(`http://127.0.0.1:${address.port}/preview`);
  const requestPromise = new Promise<IncomingMessage>(resolve => {
    ws.once("connection", (socket, request) => {
      resolve(request);
      socket.close();
    });
  });

  {
    using _api = connect(baseUrl, { accessToken: "access.jwt.value" });
    const request = await requestPromise;
    expect(request.url).toBe("/api");
    expect(request.headers.origin).toBe(baseUrl.origin);
    expect(request.headers.cookie).toBe("CF_Authorization=access.jwt.value");
  }
});
