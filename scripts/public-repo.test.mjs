// Tests for scripts/public-repo.mjs: repository visibility and authentication.
// Run with: node --test scripts/public-repo.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicRepo } from "./public-repo.mjs";

const cases = [
  { name: "public repository is public", body: { private: false, visibility: "public" }, expected: true },
  { name: "private flag rejects public visibility", body: { private: true, visibility: "public" }, expected: false },
  { name: "internal visibility is not public", body: { private: false, visibility: "internal" }, expected: false },
  { name: "404 throws", status: 404, error: /GitHub answered 404 for owner\/repo/ },
  { name: "500 throws", status: 500, error: /GitHub answered 500 for owner\/repo/ },
  { name: "missing slash rejects without fetching", repo: "nope", error: /not a repository name/ },
  { name: "extra slash rejects without fetching", repo: "a/b/c", error: /not a repository name/ },
  { name: "empty name rejects without fetching", repo: "", error: /not a repository name/ },
  { name: "token adds Bearer authorization", token: "TOKEN", body: { private: false, visibility: "public" }, expected: true },
  { name: "explicit empty token omits authorization", token: "", body: { private: false, visibility: "public" }, expected: true },
];

test("isPublicRepo", async (t) => {
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const fetchMock = t.mock.method(globalThis, "fetch", async () =>
        new Response(JSON.stringify(c.body ?? {}), { status: c.status ?? 200 }));
      const repo = c.repo ?? "owner/repo";
      const token = c.token ?? "";

      if (c.error) {
        await assert.rejects(isPublicRepo(repo, token), c.error);
      } else {
        assert.equal(await isPublicRepo(repo, token), c.expected);
      }

      if (c.repo !== undefined) {
        assert.equal(fetchMock.mock.callCount(), 0);
      } else {
        assert.equal(fetchMock.mock.callCount(), 1);
        const [url, options] = fetchMock.mock.calls[0].arguments;
        assert.equal(url, `https://api.github.com/repos/${repo}`);
        if (token) {
          assert.equal(options.headers.Authorization, `Bearer ${token}`);
        } else {
          assert.equal(Object.hasOwn(options.headers, "Authorization"), false);
        }
      }
    });
  }
});
