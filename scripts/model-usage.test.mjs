// All provider responses in this file are explicit HTTP mocks, never live-service verification.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { withPlatformContext } from "../lib/platform/context.mjs";
import { readRaw, mutatePlatform, readPlatform } from "../lib/platform/store.mjs";
import { saveModelKey, modelConfigStatus, updateModelBudget, verifyModelConnection, removeModelKey, MODEL } from "../lib/platform/model-config.mjs";
import { budgetFromState, modelBudgetDate, reserveModelUsage } from "../lib/platform/model-usage.mjs";
import { extractInquiry } from "../lib/platform/inquiry-extract.mjs";
import { researchCompany } from "../lib/platform/research.mjs";
import { act } from "../lib/platform/domain.mjs";

async function database() {
  const raw = new DatabaseSync(":memory:");
  for (const file of (await readdir(new URL("../drizzle/", import.meta.url))).filter(value => value.endsWith(".sql")).sort()) raw.exec(await readFile(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  return { raw, prepare(query) { return { bind(...values) { return { async first() { return raw.prepare(query).get(...values) || null; }, async run() { return { meta: { changes: Number(raw.prepare(query).run(...values).changes) } }; } }; } }; } };
}
const context = (db, ownerId = "u:model-test", authenticated = true) => ({ db, ownerId, authenticated, dataKey: Buffer.alloc(32, 19).toString("base64url") });
const originalFetch = globalThis.fetch;
const completion = (content = "OK", extras = {}) => Response.json({ id: "synthetic-completion-id", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], ...extras });
const reserve = (id, options = {}) => reserveModelUsage({ runId: "fixture-" + id, inputHash: "synthetic-hash", requestedModel: MODEL, ...options });

test("Budget uses all raw attempts and Asia/Shanghai midnight, including failures and in-flight reservations", () => {
  assert.equal(modelBudgetDate("2026-11-21T15:59:59Z"), "2026-11-21");
  assert.equal(modelBudgetDate("2026-11-21T16:00:00Z"), "2026-11-22");
  const state = { runLog: [
    { type: "model_call", status: "failed", startedAt: "2026-11-21T15:59:59Z" },
    { type: "model_call", status: "in_flight", startedAt: "2026-11-21T16:00:00Z" },
    ...Array.from({ length: 150 }, () => ({ type: "website_research", startedAt: "2026-11-22T00:00:00Z" }))
  ] };
  const result = budgetFromState(state, Date.parse("2026-11-22T00:00:00Z"));
  assert.equal(result.dailyLimit, null); assert.equal(result.unlimited, true); assert.equal(result.used, 1); assert.equal(result.remaining, null); assert.equal(result.timezone, "Asia/Shanghai");
  assert.equal(budgetFromState(state, Date.parse("2026-11-23T00:00:00Z")).used, 0);
});

test("Saving a key never calls the provider; invalid parameters, missing key and guest operations spend nothing", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    globalThis.fetch = async () => { calls++; throw new Error("Unexpected provider request"); };
    await assert.rejects(() => verifyModelConnection(), error => error.code === "MODEL_NOT_CONFIGURED");
    await assert.rejects(() => saveModelKey("bad"), error => error.code === "INVALID_KEY");
    await assert.rejects(() => updateModelBudget(11), error => error.code === "MODEL_BUDGET_UNLIMITED");
    const status = await saveModelKey("synthetic-not-a-provider-key");
    assert.equal(status.configured, true); assert.equal(status.currentConfigVerified, false); assert.equal(status.budget.dailyLimit, null); assert.equal(status.budget.unlimited, true); assert.equal(status.budget.used, 0);
    await assert.rejects(() => extractInquiry({ sourceText: "" }), error => error.code === "EXTRACTION_INVALID_INPUT");
    await assert.rejects(() => extractInquiry({ sourceText: "WVA 19488", companyId: "not-owned" }), error => error.code === "NOT_FOUND");
    assert.equal(calls, 0); assert.equal((await readRaw()).state.runLog.length, 0);
    await withPlatformContext(context(db, "v:guest", false), async () => { await assert.rejects(() => updateModelBudget(10), error => error.code === "SIGN_IN_REQUIRED"); await assert.rejects(() => verifyModelConnection(), error => error.code === "SIGN_IN_REQUIRED"); });
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Explicit mocked connection check is one 32-token call and exposes only safe separate model/ID/usage metadata", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    const key = "synthetic-private-config-value"; await saveModelKey(key);
    globalThis.fetch = async (url, options) => {
      calls++; assert.equal(String(url), "https://token.b1x.work/v1/chat/completions");
      const request = JSON.parse(options.body); assert.equal(request.model, MODEL); assert.equal(request.max_tokens, 32); assert.equal(request.stream, false);
      assert.equal(request.messages.length, 1); assert.ok(request.messages[0].content.includes("no customer data"));
      return new Response(JSON.stringify({ id: "synthetic-completion-123", model: "provider-reported-model", choices: [{ message: { content: "SENSITIVE RESPONSE NOT FOR STATUS" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }), { headers: { "content-type": "application/json", "x-request-id": "synthetic-http-request-456" } });
    };
    const status = await verifyModelConnection(); assert.equal(calls, 1); assert.equal(status.currentConfigVerified, true); assert.ok(status.verifiedAt); assert.equal(status.budget.used, 1);
    const row = status.lastAttempt; assert.equal(row.purpose, "connection_verification"); assert.equal(row.requestedModel, MODEL); assert.equal(row.responseModel, "provider-reported-model"); assert.equal(row.requestId, "synthetic-http-request-456"); assert.equal(row.completionId, "synthetic-completion-123"); assert.equal(row.usage.totalTokens, 9); assert.equal(row.businessValidated, null); assert.equal(row.connectionSucceeded, true); assert.ok(row.durationMs >= 0);
    const serialized = JSON.stringify(status); for (const sensitive of [key, "SENSITIVE RESPONSE", "ciphertext", "responseContent", "inputHash"]) assert.equal(serialized.includes(sensitive), false, sensitive);
    assert.equal((await readRaw()).state.runLog[0].timeoutMs, 15000);
    await withPlatformContext(context(db, "u:other"), async () => { const other = await modelConfigStatus(); assert.equal(other.lastAttempt, null); assert.equal(other.budget.used, 0); assert.equal(other.currentConfigVerified, false); });
    globalThis.fetch = async () => completion();
    const noMetadata = await verifyModelConnection(); assert.equal(noMetadata.lastAttempt.responseModel, null); assert.equal(noMetadata.lastAttempt.requestId, null); assert.equal(noMetadata.lastAttempt.completionId, "synthetic-completion-id"); assert.equal(noMetadata.lastAttempt.usage, null);
    const removed = await removeModelKey(); assert.equal(removed.configured, false); assert.equal(removed.currentConfigVerified, false); assert.equal(removed.budget.used, 2);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Sent auth/server/empty/timeout failures count once each with no automatic provider retry", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    await saveModelKey("synthetic-failure-fixture-key");
    for (const status of [401, 503]) {
      globalThis.fetch = async () => { calls++; return Response.json({ error: { message: "synthetic failure" } }, { status }); };
      await assert.rejects(() => verifyModelConnection(), error => error.code === (status === 401 ? "MODEL_AUTH_REJECTED" : "MODEL_CALL_FAILED"));
    }
    globalThis.fetch = async () => { calls++; return completion("   "); };
    await assert.rejects(() => verifyModelConnection(), error => error.code === "MODEL_EMPTY");
    globalThis.fetch = async () => { calls++; const error = new Error("synthetic timeout"); error.name = "AbortError"; throw error; };
    await assert.rejects(() => verifyModelConnection(), error => error.code === "MODEL_TIMEOUT");
    const status = await modelConfigStatus(); assert.equal(calls, 4); assert.equal(status.budget.used, 4); assert.equal(status.lastAttempt.status, "outcome_unknown"); assert.equal(status.currentConfigVerified, false); assert.equal(status.lastSuccessfulCall, null);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("A real response with invalid business schema verifies connectivity but cannot validate an inquiry", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    await saveModelKey("synthetic-schema-fixture-key");
    globalThis.fetch = async () => completion("not json", { model: "provider-model" });
    await assert.rejects(() => extractInquiry({ sourceText: "Please supply WVA 19488." }), error => error.publicError && error.code !== "MODEL_CALL_FAILED");
    const status = await modelConfigStatus(); assert.equal(status.currentConfigVerified, true); assert.equal(status.lastAttempt.connectionSucceeded, true); assert.equal(status.lastAttempt.businessValidated, false); assert.equal(status.lastAttempt.purpose, "inquiry"); assert.equal(status.lastAttempt.status, "failed"); assert.equal(status.budget.used, 1);
    globalThis.fetch = async () => completion(JSON.stringify({ fields: [{ field: "partCode", value: "19488", quote: "WVA 19488" }], unknowns: [] }));
    await extractInquiry({ sourceText: "Please supply WVA 19488." });
    assert.equal((await modelConfigStatus()).lastAttempt.businessValidated, true);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("A previous configuration's in-flight success cannot verify a newly saved key", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    const old = await saveModelKey("synthetic-old-config-key");
    let release, notify;
    const entered = new Promise(resolve => { notify = resolve; });
    globalThis.fetch = async () => { notify(); await new Promise(resolve => { release = resolve; }); return completion(); };
    const pending = verifyModelConnection(); await entered;
    const replacement = await saveModelKey("synthetic-new-config-key"); assert.notEqual(replacement.configSavedAt, old.configSavedAt); assert.equal(replacement.currentConfigVerified, false);
    release(); const after = await pending;
    assert.equal(after.currentConfigVerified, false); assert.equal(after.lastSuccessfulCall.configSavedAt, old.configSavedAt); assert.equal(after.budget.used, 1);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Concurrent key saves in the same millisecond receive distinct CAS versions, preventing cross-key verification", async () => {
  const db = await database(), originalNow = Date.now;
  try { await withPlatformContext(context(db), async () => {
    const original = await saveModelKey("synthetic-initial-config-key");
    Date.now = () => Date.parse(original.configSavedAt);
    const prepare = db.prepare.bind(db), versions = []; let reads = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    db.prepare = query => ({ bind(...args) {
      const statement = prepare(query).bind(...args);
      return {
        async first() {
          const value = await statement.first();
          if (query === "SELECT updated_at FROM model_config WHERE owner_id = ?" && ++reads <= 2) { if (reads === 2) release(); await barrier; }
          return value;
        },
        async run() { const result = await statement.run(); if (query.startsWith("UPDATE model_config SET") && result.meta.changes === 1) versions.push(args[2]); return result; }
      };
    } });
    await Promise.all([saveModelKey("synthetic-concurrent-first-key"), saveModelKey("synthetic-concurrent-second-key")]);
    assert.equal(versions.length, 2); assert.notEqual(versions[0], versions[1]);
    await mutatePlatform(state => { state.runLog.push({ id: "synthetic-prior-key-success", type: "model_call", status: "connection_verified", connectionSucceeded: true, purpose: "connection_verification", requestedModel: MODEL, configSavedAt: versions[0], startedAt: versions[0], finishedAt: versions[1] }); });
    const status = await modelConfigStatus(); assert.equal(status.configSavedAt, versions[1]); assert.equal(status.currentConfigVerified, false);
  }); } finally { Date.now = originalNow; db.raw.close(); }
});

test("Website research shares the durable budget and metadata; a fresh cached result sends no second model request", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    await saveModelKey("synthetic-research-fixture-key");
    const state = await act("create_company", { name: "Synthetic research fixture", website: "https://research.example" }), companyId = state.companies[0].id;
    globalThis.fetch = async url => {
      if (String(url).startsWith("https://research.example")) return new Response("<main><p>Generic business information with no verified buying intent.</p></main>", { headers: { "content-type": "text/html" } });
      calls++; return completion(JSON.stringify({ websiteFacts: [], productMatches: [], openingQuestion: null, unknowns: ["Missing product and buyer role evidence"], recommendedNextAction: "Ask for the relevant product catalogue." }), { model: "synthetic-research-response-model" });
    };
    await researchCompany(companyId);
    const status = await modelConfigStatus(); assert.equal(calls, 1); assert.equal(status.budget.used, 1); assert.equal(status.currentConfigVerified, true); assert.equal(status.lastAttempt.purpose, "research"); assert.equal(status.lastAttempt.businessValidated, true);
    const cached = await researchCompany(companyId); assert.equal(cached.meta.cached, true); assert.equal(calls, 1); assert.equal((await modelConfigStatus()).budget.used, 1);
    assert.equal(JSON.stringify(status).includes("responseContent"), false);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Old caps do not block the 31st or 51st request; atomic registration preserves concurrent attempts and rejects duplicate IDs", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    await saveModelKey("synthetic-budget-fixture-key");
    await mutatePlatform(state => { state.modelBudgetDailyLimit = 4; });
    for (let index = 0; index < 30; index++) await reserve(index);
    globalThis.fetch = async () => { calls++; return completion(); };
    const thirtyFirst = await verifyModelConnection(); assert.equal(thirtyFirst.budget.used, 31); assert.equal(calls, 1);
    for (let index = 31; index < 50; index++) await reserve(index);
    const outcomes = await Promise.allSettled([verifyModelConnection(), verifyModelConnection()]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 2); assert.equal(calls, 3);
    const status = await modelConfigStatus(); assert.equal(status.budget.used, 52); assert.equal(status.budget.unlimited, true); assert.equal(status.budget.remaining, null);
    const attempts = (await readRaw()).state.runLog.filter(row => row.type === "model_call");
    assert.equal(new Set(attempts.map(row => row.id)).size, 52);
    await assert.rejects(() => reserve(0), error => error.code === "MODEL_CALL_ALREADY_RESERVED"); assert.equal((await modelConfigStatus()).budget.used, 52);
    await mutatePlatform(state => { for (let index = 0; index < 105; index++) state.runLog.push({ id: "non-model-" + index, type: "website_research", startedAt: new Date().toISOString() }); });
    assert.equal((await readPlatform()).runLog.some(row => row.type === "model_call"), false);
    assert.equal((await modelConfigStatus()).budget.used, 52);
    await verifyModelConnection(); assert.equal(calls, 4); assert.equal((await modelConfigStatus()).budget.used, 53);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});
