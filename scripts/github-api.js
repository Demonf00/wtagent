/**
 * Narrow GitHub API client for the opted-in WTAgent PR verifier/watcher.
 * Public reads work without GitHub CLI. Writes require an explicit token.
 * Never send credentials to an arbitrary URL or print response bodies.
 */
const READ_ROUTE = /^repos\/Demonf00\/wtagent\/(?:pulls\/[1-9][0-9]*|pulls\?state=open&per_page=100)$/;
const COMMENT_ROUTE = /^repos\/Demonf00\/wtagent\/issues\/[1-9][0-9]*\/comments$/;

export async function githubApi(route, {
  method = "GET",
  body = null,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null,
  request = globalThis.fetch,
} = {}) {
  if ((method === "GET" && !READ_ROUTE.test(route))
    || (method === "POST" && !COMMENT_ROUTE.test(route))) {
    throw new Error("GitHub API method or route not allowlisted.");
  }
  if (method !== "GET" && method !== "POST") throw new Error("GitHub API method not allowed.");
  if (method === "POST" && (!token || typeof token !== "string")) {
    throw new Error("GitHub comment posting requires GH_TOKEN or GITHUB_TOKEN.");
  }
  if (method === "GET" && body !== null) throw new Error("GET must not include a body.");
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "WTAgent-PR-Verifier",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = "Bearer " + token;
  if (method === "POST") headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await request("https://api.github.com/" + route, {
      method, headers, redirect: "error", signal: AbortSignal.timeout(20000),
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error("GitHub API network request failed.");
  }
  if (!response.ok) {
    throw new Error("GitHub API " + method + " failed (HTTP " + response.status + ").");
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Invalid GitHub API JSON response.");
  }
}
