// Explicit mocked HTTP responses only. This suite does not claim a real Tavily Key was verified.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { withPlatformContext } from "../lib/platform/context.mjs";
import { readPlatform } from "../lib/platform/store.mjs";
import { act } from "../lib/platform/domain.mjs";
import { sealKey, unsealKey, saveModelKey, getModelKey } from "../lib/platform/model-config.mjs";
import { searchConfigStatus, saveSearchKey, getSearchConnection, verifySearchConnection } from "../lib/platform/search-config.mjs";
import { searchPublicCandidates, searchFailureMetadata, planBuyerDiscovery, searchMoreBuyers } from "../lib/platform/buyer-discovery.mjs";
import { planCompanyWebsite, searchCompanyWebsite } from "../lib/platform/company-website.mjs";

async function database() {
  const raw = new DatabaseSync(":memory:");
  for (const file of (await readdir(new URL("../drizzle/", import.meta.url))).filter(value => value.endsWith(".sql")).sort()) raw.exec(await readFile(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  return { raw, prepare(query) { return { bind(...values) { return { async first() { return raw.prepare(query).get(...values) || null; }, async run() { return { meta: { changes: Number(raw.prepare(query).run(...values).changes) } }; } }; } }; } };
}
const secret = Buffer.alloc(32, 13).toString("base64url");
const fakeKey = "tvly-test-FAKE-NOT-A-REAL-KEY-0123456789";
const otherKey = "tvly-test-FAKE-SECOND-KEY-0123456789";
const context = (db, ownerId = "u:search-config-a", authenticated = true) => ({ db, ownerId, authenticated, dataKey: secret });
const originalFetch = globalThis.fetch;
const response = (results = [], extra = {}) => Response.json({ request_id: "mock-request-id", results, ...extra });
const genericHit = { title: "Mock company", url: "https://candidate.test", content: "Mocked public search content" };
const criteria = { productId: "", category: "brake_lining", targetMarket: "UK", buyerRoles: ["distributor"], extraTerms: "", excludedTerms: "" };
async function buyerSearch(companyId, targetMarket = "UK") {
  const input = { ...criteria, targetMarket }, plan = await planBuyerDiscovery({ seedCompanyId: companyId, criteria: input });
  return searchMoreBuyers({ seedCompanyId: companyId, criteria: input, planHash: plan.planHash, confirmed: true });
}

test("Tavily configuration encrypts per account and service, save never calls provider, status never reveals either Key", async () => {
  const db = await database(); let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error("Save must not call network"); };
    const a = context(db), b = context(db, "u:search-config-b"), guest = context(db, "v:guest", false);
    await withPlatformContext(a, async () => {
      await saveModelKey("synthetic-b1x-only-model-key");
      const status = await saveSearchKey(fakeKey);
      assert.equal(status.provider, "Tavily"); assert.equal(status.authMode, "keyed"); assert.equal(status.lastVerification, null); assert.equal(calls, 0);
      const row = db.raw.prepare("SELECT * FROM search_config WHERE owner_id = ?").get(a.ownerId);
      assert.ok(!JSON.stringify(row).includes(fakeKey)); assert.ok(!JSON.stringify(status).includes(fakeKey));
      assert.equal((await getSearchConnection()).apiKey, fakeKey); assert.equal(await getModelKey(), "synthetic-b1x-only-model-key");
      await assert.rejects(unsealKey(row, secret, a.ownerId), error => error.code === "KEY_CONFIG_UNREADABLE");
      await assert.rejects(unsealKey(row, secret, "tavily-search:" + b.ownerId), error => error.code === "KEY_CONFIG_UNREADABLE");
      const modelSealed = await sealKey("synthetic-model-only", secret, a.ownerId);
      await assert.rejects(unsealKey(modelSealed, secret, "tavily-search:" + a.ownerId), error => error.code === "KEY_CONFIG_UNREADABLE");
      await assert.rejects(saveSearchKey("synthetic-b1x-only-model-key"), error => error.code === "SEARCH_INVALID_KEY");
    });
    assert.equal((await withPlatformContext(b, searchConfigStatus)).configured, false);
    await assert.rejects(withPlatformContext(b, getSearchConnection), error => error.code === "SEARCH_NOT_CONFIGURED");
    await assert.rejects(withPlatformContext(guest, getSearchConnection), error => error.code === "SEARCH_NOT_CONFIGURED");
    await assert.rejects(withPlatformContext(guest, () => saveSearchKey(fakeKey)), error => error.code === "SIGN_IN_REQUIRED");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Explicit keyed verification sends exactly one fixed basic query and returns only safe response metadata", async () => {
  const db = await database(); const calls = [];
  try { await withPlatformContext(context(db), async () => {
    await assert.rejects(verifySearchConnection(), error => error.code === "SEARCH_NOT_CONFIGURED");
    const saved = await saveSearchKey(fakeKey);
    globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return response([genericHit], { usage: { credits: 1, key: fakeKey } }); };
    const status = await verifySearchConnection();
    assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://api.tavily.com/search");
    assert.equal(calls[0].options.headers.Authorization, "Bearer " + fakeKey); assert.equal(calls[0].options.headers["X-Tavily-Access-Mode"], undefined);
    const body = JSON.parse(calls[0].options.body); assert.equal(body.max_results, 3); assert.equal(body.search_depth, "basic"); assert.equal(body.query, "commercial vehicle brake lining distributor"); assert.equal(body.api_key, undefined);
    assert.equal(status.lastVerification.status, "succeeded"); assert.equal(status.lastVerification.configSavedAt, saved.configSavedAt); assert.equal(status.lastVerification.httpStatus, 200);
    assert.equal(status.lastVerification.resultCount, 1); assert.equal(status.lastVerification.credits, 1); assert.equal(status.lastVerification.requestId, "mock-request-id");
    assert.ok(!JSON.stringify(status).includes(fakeKey)); assert.ok(!JSON.stringify(status).includes(genericHit.content));
    assert.equal((await readPlatform()).runLog.length, 0); assert.equal((await readPlatform()).discoveryRuns.length, 0);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("HTTP429 keeps explicit daily cap diagnosis, request ID and Retry-After while redacting secrets and not retrying", async () => {
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return Response.json({ request_id: "diagnostic-request", error: { code: "daily_cap_reached", message: "Daily keyless limit; api_key=" + fakeKey + "; Authorization: Bearer hidden-auth-value password=hidden-password" } }, { status: 429, headers: { "retry-after": "360" } }); };
    await assert.rejects(searchPublicCandidates("public generic query", { apiKey: fakeKey }), error => {
      const meta = searchFailureMetadata(error);
      assert.equal(error.code, "SEARCH_RATE_LIMIT"); assert.equal(meta.httpStatus, 429); assert.equal(meta.providerCode, "daily_cap_reached"); assert.equal(meta.retryAfterSeconds, 360); assert.equal(meta.retryAfter, "360"); assert.equal(meta.requestId, "diagnostic-request"); assert.ok(meta.durationMs >= 0);
      assert.match(error.message, /每日/); assert.match(error.message, /不保证/);
      assert.ok(!JSON.stringify(meta).includes(fakeKey)); assert.ok(!JSON.stringify(meta).includes("hidden-auth-value")); assert.ok(!JSON.stringify(meta).includes("hidden-password")); return true;
    });
    assert.equal(calls, 1);
    globalThis.fetch = async () => Response.json({ error: { code: "unknown_unlisted_code", message: "Unspecified restriction" } }, { status: 429 });
    await assert.rejects(searchPublicCandidates("other public query", { apiKey: fakeKey }), error => { const meta = searchFailureMetadata(error); assert.equal(meta.providerCode, undefined); assert.match(error.message, /尚不能确认/); assert.doesNotMatch(error.message, /每日/); return true; });
  } finally { globalThis.fetch = originalFetch; }
});

test("Official detail.error diagnostic keeps the HTTP432 explanation through the same secret redaction", async () => {
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return Response.json({ detail: { error: "This request exceeds your plan; api_key=" + fakeKey } }, { status: 432, headers: { "x-request-id": "plan-limit-request" } }); };
    await assert.rejects(searchPublicCandidates("public generic query", { apiKey: fakeKey }), error => {
      const meta = searchFailureMetadata(error);
      assert.equal(meta.httpStatus, 432); assert.equal(meta.requestId, "plan-limit-request");
      assert.match(meta.providerMessage, /This request exceeds your plan/);
      assert.ok(!JSON.stringify(meta).includes(fakeKey)); assert.equal(meta.providerCode, undefined);
      return true;
    });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("Malformed/oversized error bodies stay bounded and retain safe status/headers; no raw HTML or network exception leaks", async () => {
  try {
    globalThis.fetch = async () => new Response('<html>SECRET=' + 'x'.repeat(20000) + '</html>', { status: 503, headers: { "x-request-id": "header-request", "retry-after": "360" } });
    await assert.rejects(searchPublicCandidates("public query", { apiKey: fakeKey }), error => { const meta = searchFailureMetadata(error); assert.equal(meta.httpStatus, 503); assert.equal(meta.requestId, "header-request"); assert.equal(meta.providerMessage, undefined); assert.ok(JSON.stringify(meta).length < 500); return true; });
    const at = new Date(Date.now() + 120000).toUTCString();
    globalThis.fetch = async () => Response.json({ error: { message: "temporary" } }, { status: 503, headers: { "retry-after": at } });
    await assert.rejects(searchPublicCandidates("public query", { apiKey: fakeKey }), error => { const meta = searchFailureMetadata(error); assert.equal(meta.retryAfter, at); assert.ok(meta.retryAfterSeconds >= 118 && meta.retryAfterSeconds <= 120); return true; });
    globalThis.fetch = async () => { throw new Error("Network failure secret " + fakeKey); };
    await assert.rejects(searchPublicCandidates("public query", { apiKey: fakeKey }), error => { assert.equal(error.code, "SEARCH_UNAVAILABLE"); assert.ok(!error.message.includes(fakeKey)); assert.ok(!JSON.stringify(searchFailureMetadata(error)).includes(fakeKey)); return true; });
  } finally { globalThis.fetch = originalFetch; }
});

test("Failed verification records safe metadata, uses keyed auth once and never falls back to keyless", async () => {
  const db = await database(); const calls = [];
  try { await withPlatformContext(context(db), async () => {
    await saveSearchKey(fakeKey);
    globalThis.fetch = async (_url, options) => { calls.push(options); return Response.json({ error: { code: "invalid_api_key", message: "Rejected " + fakeKey } }, { status: 401, headers: { "x-request-id": "rejected-key-request" } }); };
    await assert.rejects(verifySearchConnection(), error => error.code === "SEARCH_AUTH_REJECTED");
    const status = await searchConfigStatus();
    assert.equal(calls.length, 1); assert.equal(calls[0].headers.Authorization, "Bearer " + fakeKey); assert.equal(calls[0].headers["X-Tavily-Access-Mode"], undefined);
    assert.equal(status.lastVerification.status, "failed"); assert.equal(status.lastVerification.httpStatus, 401); assert.equal(status.lastVerification.requestId, "rejected-key-request");
    assert.equal(status.configured, true); assert.equal(status.authMode, "keyed"); assert.ok(!JSON.stringify(status).includes(fakeKey));
    assert.ok(!db.raw.prepare("SELECT last_verification FROM search_config").get().last_verification.includes(fakeKey));
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Changing the Key during verification prevents the old response validating the current version", async () => {
  const db = await database(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  try { await withPlatformContext(context(db), async () => {
    const before = await saveSearchKey(fakeKey);
    globalThis.fetch = async () => { entered(); return new Promise(resolve => { release = () => resolve(response([genericHit])); }); };
    const verifying = verifySearchConnection(); await started;
    const after = await saveSearchKey(otherKey); assert.notEqual(after.configSavedAt, before.configSavedAt);
    release(); await assert.rejects(verifying, error => error.code === "SEARCH_CONFIG_CHANGED");
    const status = await searchConfigStatus(); assert.equal(status.configSavedAt, after.configSavedAt); assert.equal(status.lastVerification, null); assert.equal((await getSearchConnection()).apiKey, otherKey);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Concurrent verification is reserved before sending and does not multiply paid requests", async () => {
  const db = await database(); let release, entered, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  try { await withPlatformContext(context(db), async () => {
    await saveSearchKey(fakeKey);
    globalThis.fetch = async () => { calls++; entered(); return new Promise(resolve => { release = () => resolve(response([])); }); };
    const first = verifySearchConnection(); await started;
    await assert.rejects(verifySearchConnection(), error => error.code === "SEARCH_VERIFICATION_BUSY");
    assert.equal(calls, 1); release(); const status = await first; assert.equal(status.lastVerification.status, "succeeded"); assert.equal(status.lastVerification.resultCount, 0);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Configuration CAS yields distinct versions even when concurrent saves share a clock millisecond", async () => {
  const db = await database(), realNow = Date.now; const versions = [];
  try { await withPlatformContext(context(db), async () => {
    const initial = await saveSearchKey(fakeKey); Date.now = () => Date.parse(initial.configSavedAt);
    let reads = 0, release; const barrier = new Promise(resolve => { release = resolve; });
    const racingDb = { prepare(query) { return { bind(...args) { const statement = db.prepare(query).bind(...args); return {
      async first() { const result = await statement.first(); if (query === "SELECT updated_at FROM search_config WHERE owner_id = ?" && ++reads <= 2) { if (reads === 2) release(); await barrier; } return result; },
      async run() { const result = await statement.run(); if (query.startsWith("UPDATE search_config SET ciphertext") && result.meta.changes === 1) versions.push(args[2]); return result; }
    }; } }; } };
    await Promise.all([withPlatformContext(context(racingDb), () => saveSearchKey(otherKey)), withPlatformContext(context(racingDb), () => saveSearchKey("tvly-test-THIRD-FAKE-KEY-0123456789"))]);
    assert.equal(versions.length, 2); assert.notEqual(versions[0], versions[1]); assert.ok(versions[0] > initial.configSavedAt); assert.ok(versions[1] > versions[0]);
    assert.equal((await searchConfigStatus()).lastVerification, null);
  }); } finally { Date.now = realNow; db.raw.close(); }
});

test("Both business search paths use only current owner's Key and propagate failure diagnostics", async () => {
  const db = await database(); const calls = [];
  try { await withPlatformContext(context(db), async () => {
    await saveSearchKey(fakeKey);
    const state = await act("create_company", { name: "Known public name" }), companyId = state.companies[0].id;
    globalThis.fetch = async (_url, options) => { calls.push(options); return Response.json({ error: { code: "daily_cap_reached", message: "Daily cap" } }, { status: 429, headers: { "retry-after": "360", "x-request-id": "runtime-failure" } }); };
    const buyers = (await buyerSearch(companyId)).result.run;
    const plan = await planCompanyWebsite({ companyId });
    const website = (await searchCompanyWebsite({ companyId, criteria: plan.criteria, planHash: plan.planHash, confirmed: true })).result.run;
    for (const run of [buyers, website]) {
      assert.equal(run.status, "failed"); assert.equal(run.authMode, "keyed"); assert.ok(run.provider.includes("账号 Key")); assert.ok(run.searchConfigSavedAt); assert.equal(run.candidates.length, 0);
      for (const query of run.queries) { assert.equal(query.httpStatus, 429); assert.equal(query.providerCode, "daily_cap_reached"); assert.equal(query.retryAfterSeconds, 360); assert.equal(query.requestId, "runtime-failure"); assert.ok(query.durationMs >= 0); }
      assert.ok(!JSON.stringify(run).includes(fakeKey));
    }
    assert.equal(calls.length, 4); assert.ok(calls.every(call => call.headers.Authorization === "Bearer " + fakeKey && !call.headers["X-Tavily-Access-Mode"]));
    await assert.rejects(withPlatformContext(context(db, "u:unconfigured-owner"), getSearchConnection), error => error.code === "SEARCH_NOT_CONFIGURED");
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Rotating a Key does not relabel old cached provenance; explicit verification bypasses business cache", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    const state = await act("create_company", { name: "Cache source" }), companyId = state.companies[0].id;
    globalThis.fetch = async () => { calls++; return response([genericHit]); };
    await saveSearchKey(fakeKey);
    const first = (await buyerSearch(companyId)).result.run; assert.equal(first.authMode, "keyed"); assert.equal(calls, 2);
    await saveSearchKey(otherKey);
    const cached = (await buyerSearch(companyId)).result; assert.equal(cached.cached, true); assert.equal(cached.run.id, first.id); assert.equal(cached.run.authMode, "keyed"); assert.equal(cached.run.provider, "Tavily Search · 账号 Key"); assert.equal(cached.run.searchConfigSavedAt, first.searchConfigSavedAt); assert.equal(calls, 2);
    const verified = await verifySearchConnection(); assert.equal(calls, 3); assert.equal(verified.lastVerification.status, "succeeded");
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});
