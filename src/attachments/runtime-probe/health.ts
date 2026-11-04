import { get } from "node:http";
/** Fixed loopback health only: no redirect, credentials, cookies or proxy. */
export function observeHealth(
  port: number,
  signal: AbortSignal,
): Promise<number> {
  if (signal.aborted) return Promise.reject(Error("PHASE30_PROBE_ABORTED"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    return Promise.reject(Error("PHASE30_PROBE_HEALTH"));
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (ok) resolve(performance.now() - started);
      else reject(Error("PHASE30_PROBE_HEALTH"));
    };
    const request = get(
      { hostname: "127.0.0.1", port, path: "/api/v1/health", agent: false },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          finish(false);
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024) {
            response.destroy();
            finish(false);
          } else chunks.push(chunk);
        });
        response.once("error", () => finish(false));
        response.once("aborted", () => finish(false));
        response.once("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            finish(
              data.success === true &&
                data.data?.status === "ok" &&
                data.data?.environment === "test" &&
                data.data?.service === "congdongngonngu-backend",
            );
          } catch {
            finish(false);
          }
        });
      },
    );
    const cancel = () => {
      request.destroy();
      finish(false);
    };
    const timer = setTimeout(cancel, 1800);
    request.once("error", () => finish(false));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
