import { createServer, type Server, type RequestListener } from "node:http";
import { observeHealth } from "./health";
async function server(
  handler: RequestListener,
): Promise<{ server: Server; port: number }> {
  const app = createServer(handler);
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  const address = app.address();
  if (!address || typeof address === "string") throw Error("test listen");
  return { server: app, port: address.port };
}
describe("finite credential-free loopback health observations", () => {
  it.each([
    ["test", true],
    ["production", false],
  ])("requires exact TEST identity for %s", async (environment, ok) => {
    const app = await server((_req, res) =>
      res.end(
        JSON.stringify({
          success: true,
          data: {
            status: "ok",
            service: "congdongngonngu-backend",
            environment,
          },
        }),
      ),
    );
    try {
      if (ok)
        expect(
          await observeHealth(app.port, new AbortController().signal),
        ).toBeGreaterThanOrEqual(0);
      else
        await expect(
          observeHealth(app.port, new AbortController().signal),
        ).rejects.toThrow("PHASE30_PROBE_HEALTH");
    } finally {
      await new Promise<void>((done) => app.server.close(() => done()));
    }
  });
  it("rejects redirects and oversize bodies, never following another destination", async () => {
    for (const status of [302, 200]) {
      const app = await server((_req, res) => {
        res.statusCode = status;
        res.setHeader("Location", "https://example.invalid/private");
        res.end("x".repeat(1025));
      });
      try {
        await expect(
          observeHealth(app.port, new AbortController().signal),
        ).rejects.toThrow("PHASE30_PROBE_HEALTH");
      } finally {
        await new Promise<void>((done) => app.server.close(() => done()));
      }
    }
  });
  it("cancels a stalled response with a fixed error", async () => {
    const app = await server(() => {});
    const abort = new AbortController();
    try {
      const work = observeHealth(app.port, abort.signal);
      abort.abort();
      await expect(work).rejects.toThrow("PHASE30_PROBE_HEALTH");
    } finally {
      app.server.closeAllConnections();
      await new Promise<void>((done) => app.server.close(() => done()));
    }
  });
});
