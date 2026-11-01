// Invoked only by the verifier as a dedicated, time-bounded child process.
// No arbitrary hosts, redirects, methods, headers, or response bodies are exposed.
import http from "node:http";
import { createHash } from "node:crypto";

const MAX_BODY_BYTES = 16 * 1024;
const [rawPort, route, rawStatus, expectedText] = process.argv.slice(2);

function fail() {
  process.stderr.write("Local integration probe did not meet its acceptance check.\n");
  process.exitCode = 1;
}

if (!/^[0-9]{4,5}$/.test(rawPort ?? "")
  || Number(rawPort) < 1024 || Number(rawPort) > 65535
  || typeof route !== "string" || route.length > 512
  || !/^\/[A-Za-z0-9/_?=&.%+-]*$/.test(route)
  || route.startsWith("//")
  || !/^[1-5][0-9]{2}$/.test(rawStatus ?? "")
  || typeof expectedText !== "string" || !expectedText.length
  || Buffer.byteLength(expectedText, "utf8") > 256) {
  fail();
} else {
  let completed = false;
  function finish(ok, result) {
    if (completed) return;
    completed = true;
    if (!ok) {
      fail();
      return;
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  }
  const request = http.request({
    hostname: "127.0.0.1",
    family: 4,
    port: Number(rawPort),
    path: route,
    method: "GET",
    agent: false,
    headers: { accept: "application/json, text/plain, */*" },
  }, (response) => {
    const chunks = [];
    let bytes = 0;
    response.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        request.destroy();
        finish(false);
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => {
      if (completed) return;
      const body = Buffer.concat(chunks);
      const statusCode = response.statusCode;
      if (statusCode !== Number(rawStatus)
        || statusCode >= 300 && statusCode < 400
        || !body.toString("utf8").includes(expectedText)) {
        finish(false);
        return;
      }
      finish(true, {
        schema: 1,
        statusCode,
        bodyBytes: body.length,
        bodyHash: createHash("sha256").update(body).digest("hex"),
        containsExpected: true,
      });
    });
    response.on("error", () => finish(false));
    response.on("aborted", () => finish(false));
  });
  request.setTimeout(3000, () => request.destroy());
  request.on("error", () => finish(false));
  request.end();
}
