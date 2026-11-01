import test from "node:test";
import assert from "node:assert/strict";
import { githubApi } from "../scripts/github-api.js";

const PR = "repos/Demonf00/wtagent/pulls/11";
const LIST = "repos/Demonf00/wtagent/pulls?state=open&per_page=100";
const COMMENTS = "repos/Demonf00/wtagent/issues/11/comments";

function fakeResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("public PR GET works without gh CLI or token and limits remote endpoint", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return fakeResponse({ number: 11, state: "open" });
  };
  const result = await githubApi(PR, { request, token: null });
  assert.deepEqual(result, { number: 11, state: "open" });
  assert.equal(calls[0].url, "https://api.github.com/" + PR);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(await githubApi(LIST, { request, token: null }), result);
});

test("write comments only to trusted endpoint with explicit token", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return fakeResponse({ id: 12 });
  };
  await assert.rejects(
    githubApi(COMMENTS, { method: "POST", body: { body: "Pass" }, token: null, request }),
    /requires GH_TOKEN/,
  );
  assert.equal(calls.length, 0);
  const result = await githubApi(COMMENTS, {
    method: "POST", body: { body: "Pass" }, token: "mock-token", request,
  });
  assert.deepEqual(result, { id: 12 });
  assert.equal(calls[0].url, "https://api.github.com/" + COMMENTS);
  assert.equal(calls[0].options.headers.Authorization, "Bearer mock-token");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.equal(calls[0].options.body, JSON.stringify({ body: "Pass" }));
});

test("method and route restrictions fail closed before any network request", async () => {
  let requests = 0;
  const request = async () => { requests++; return fakeResponse({}); };
  const cases = [
    ["repos/other/wtagent/pulls/11", "GET"],
    ["repos/Demonf00/wtagent/contents/secrets", "GET"],
    ["repos/Demonf00/wtagent/pulls/11/merge", "POST"],
    [PR, "POST"],
    [COMMENTS, "GET"],
    [PR + "/../issues/11/comments", "GET"],
    ["https://attacker.example/" + PR, "GET"],
    [PR, "DELETE"],
  ];
  for (const [route, method] of cases) {
    await assert.rejects(githubApi(route, {
      method, token: "mock-token", request,
    }), /not allowlisted|not allowed/);
  }
  await assert.rejects(githubApi(PR, { body: { x: 1 }, token: null, request }), /must not include/);
  assert.equal(requests, 0);
});

test("HTTP errors, network failures and invalid JSON cannot produce verified data", async () => {
  await assert.rejects(githubApi(PR, {
    token: null, request: async () => fakeResponse({}, 403),
  }), /HTTP 403/);
  await assert.rejects(githubApi(PR, {
    token: null, request: async () => { throw new Error("secret token leaked"); },
  }), /network request failed/);
  await assert.rejects(githubApi(PR, {
    token: null, request: async () => ({
      ok: true, json: async () => { throw new Error("bad JSON"); },
    }),
  }), /Invalid GitHub API JSON/);
});
