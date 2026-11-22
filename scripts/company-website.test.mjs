// All network responses in this file are explicit mocks; these tests do not verify live service availability.
import test from "node:test";
import { saveSearchKey } from "../lib/platform/search-config.mjs";
const fakeKey = "tvly-test-SYNTHETIC-NOT-REAL-0123456789";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { withPlatformContext } from "../lib/platform/context.mjs";
import { readPlatform, mutatePlatform } from "../lib/platform/store.mjs";
import { act } from "../lib/platform/domain.mjs";
import { planBuyerDiscovery, searchMoreBuyers } from "../lib/platform/buyer-discovery.mjs";
import { planCompanyWebsite, searchCompanyWebsite, inspectCompanyWebsite, inspectCompanyWebsiteUrl, attachCompanyWebsite, websiteIdentityEvidence } from "../lib/platform/company-website.mjs";

async function database() {
  const raw = new DatabaseSync(":memory:");
  for (const file of (await readdir(new URL("../drizzle/", import.meta.url))).filter(value => value.endsWith(".sql")).sort()) raw.exec(await readFile(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  return { raw, prepare(query) { return { bind(...values) { return { async first() { return raw.prepare(query).get(...values) || null; }, async run() { return { meta: { changes: Number(raw.prepare(query).run(...values).changes) } }; } }; } }; } };
}
const context = (db, ownerId = "v:website-test") => ({ db, ownerId, authenticated: true, dataKey: Buffer.alloc(32, 17).toString("base64url") });
const originalFetch = globalThis.fetch;
const hit = (url, title = "Example Brakes") => ({ url, title, content: "Name search snippet only; identity not verified." });
const response = results => Response.json({ request_id: "mock-provider-id", results });
const html = body => new Response('<html><head><title>Example Brakes Ltd</title></head><body>' + body + '</body></html>', { headers: { "content-type": "text/html" } });
async function seed() {
  await saveSearchKey(fakeKey);
  const state = await act("create_company", { name: "Example Brakes Ltd", market: "Private market", notes: "PRIVATE financial 999, chats and contacts", grade: "A", owner: "Original owner", stage: "报价沟通", buyerRole: "Manual role" });
  return state.companies.at(-1).id;
}
async function search(companyId, criteria = { name: "Example Brakes Ltd", country: "United Kingdom" }) {
  const plan = await planCompanyWebsite({ companyId, criteria });
  return searchCompanyWebsite({ companyId, criteria: plan.criteria, planHash: plan.planHash, confirmed: true });
}
async function checked(companyId) {
  globalThis.fetch = async url => String(url).includes("api.tavily.com") ? response([hit("https://example-brakes.test/")]) : html('<main><p>Example Brakes Ltd provides commercial vehicle components.</p><a href="/contact">Contact</a><a href="mailto:sales@example-brakes.test">Email</a><a href="tel:+441234567890">Phone</a><a href="https://wa.me/441234567891">WhatsApp</a></main>');
  const run = (await search(companyId)).result.run;
  return (await inspectCompanyWebsite({ runId: run.id, candidateId: run.candidates[0].id })).result;
}
function attachment(result, request = "request-1") {
  return { mode: "attach", runId: result.run.id, candidateId: result.candidate.id, expectedCandidateHash: result.candidate.candidateHash, expectedRevision: result.run.companyRevision, confirmIdentity: true, clientRequestId: request };
}

test("Company website plan submits reviewed name/country only, no private data; changed/unconfirmed plans fail", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    const id = await seed(), plan = await planCompanyWebsite({ companyId: id });
    assert.equal(plan.criteria.country, ""); assert.equal(plan.provider, "Tavily Search · 账号 Key"); assert.equal(plan.queries.length, 2);
    assert.ok(plan.queries.every(query => !/PRIVATE|financial|chats|Private market/.test(query)));
    await assert.rejects(searchCompanyWebsite({ companyId: id, criteria: plan.criteria, planHash: plan.planHash }), error => error.code === "WEBSITE_CONFIRM_REQUIRED");
    await assert.rejects(searchCompanyWebsite({ companyId: id, criteria: { ...plan.criteria, country: "Canada" }, planHash: plan.planHash, confirmed: true }), error => error.code === "WEBSITE_PLAN_CHANGED");
    await act("update_company", { id, expectedRevision: 1, name: "Renamed Company" });
    await assert.rejects(searchCompanyWebsite({ companyId: id, criteria: plan.criteria, planHash: plan.planHash, confirmed: true }), error => error.code === "WEBSITE_PLAN_CHANGED");
    assert.equal((await readPlatform()).websiteResolutionRuns.length, 0);
  }); } finally { db.raw.close(); }
});

test("Real provider path is reused; unsafe/platform URLs excluded, domains deduped, existing-company conflict retained, cache free", async () => {
  const db = await database(); const calls = [];
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    await act("create_company", { name: "Already saved", website: "https://known.test" });
    globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return response([hit("https://example-brakes.test"), hit("https://www.example-brakes.test/contact"), hit("https://known.test"), hit("http://127.0.0.1/"), hit("https://linkedin.com/company/private")]); };
    const first = await search(id);
    assert.equal(calls.length, 2); assert.equal(calls[0].url, "https://api.tavily.com/search"); assert.equal(calls[0].options.headers.Authorization, "Bearer " + fakeKey); assert.equal(calls[0].options.redirect, "manual");
    assert.equal(first.result.run.candidates.length, 2); assert.ok(first.result.run.candidates.find(item => item.domain === "known.test").existingCompanyId);
    assert.equal(first.result.run.candidates[0].identityEvidence.length, 0); assert.equal(first.result.run.modelCalls, 0);
    assert.equal(first.result.run.queries[0].requestId, "mock-provider-id"); assert.ok(first.result.run.queries[0].durationMs >= 0);
    assert.equal((await search(id)).result.cached, true); assert.equal(calls.length, 2);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Partial search, total provider failure, and successful empty results remain distinct", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    globalThis.fetch = async () => ++calls % 2 ? response([hit("https://one.test")]) : new Response("failed", { status: 503 });
    assert.equal((await search(id)).result.run.status, "partial");
    globalThis.fetch = async () => new Response("limited", { status: 429 });
    const failed = (await search(id, { name: "Example Brakes Ltd", country: "France" })).result.run;
    assert.equal(failed.status, "failed"); assert.equal(failed.candidates.length, 0); assert.equal(failed.queries[0].errorCode, "SEARCH_RATE_LIMIT");
    globalThis.fetch = async () => response([]);
    const empty = (await search(id, { name: "Example Brakes Ltd", country: "Germany" })).result.run;
    assert.equal(empty.status, "complete"); assert.equal(empty.candidates.length, 0);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Two actual pages yield only name mentions and explicit contact sources, never auto-confirm identity or job titles", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    const id = await seed(), result = await checked(id), candidate = result.candidate;
    assert.equal(candidate.status, "needs_review"); assert.equal(candidate.pagesFetched, 2); assert.ok(candidate.identityEvidence.length);
    assert.equal(candidate.contacts.length, 3); assert.ok(candidate.contacts.every(contact => contact.sourceUrl.startsWith("https://example-brakes.test") && contact.role.includes("岗位未确认")));
    assert.equal((await readPlatform()).companies[0].website, ""); assert.equal((await readPlatform()).companies[0].market, "Private market");
    assert.equal(websiteIdentityEvidence([{ id: "x", title: "Other Brakes", snippet: "An unrelated firm." }], "Example Brakes").length, 0);
    assert.equal(websiteIdentityEvidence([{ id: "x", title: "Example Brakes Ltd", snippet: "Third-party report about Example Brakes." }], "Example Brakes Ltd").length, 1, "mentions are reviewable, not automatically official");
    globalThis.fetch = async () => { throw new Error("should use stored evidence"); };
    assert.equal((await inspectCompanyWebsite({ runId: result.run.id, candidateId: candidate.id })).result.cached, true);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Attach is scoped/idempotent, only fills website/evidence/contacts and preserves previous contact role and business records", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    await mutatePlatform(state => { state.companies[0].contacts.push({ type: "email", value: "sales@example-brakes.test", role: "Manually confirmed purchasing contact", verification: "manual" }); state.inquiries.push({ id: "old-inquiry", companyId: id }); });
    const result = await checked(id), payload = attachment(result);
    await assert.rejects(attachCompanyWebsite({ ...payload, candidateId: "fake" }), error => error.code === "WEBSITE_CANDIDATE_NOT_FOUND");
    await assert.rejects(attachCompanyWebsite({ ...payload, expectedCandidateHash: "0".repeat(64) }), error => error.code === "WEBSITE_CANDIDATE_CHANGED");
    await assert.rejects(withPlatformContext(context(db, "v:other-owner"), () => attachCompanyWebsite(payload)), error => error.code === "WEBSITE_RUN_NOT_FOUND");
    const saved = await attachCompanyWebsite(payload), company = saved.state.companies.find(item => item.id === id);
    assert.equal(saved.result.companyId, id); assert.equal(company.grade, "A"); assert.equal(company.gradeSource, "manual"); assert.equal(company.stage, "报价沟通"); assert.equal(company.buyerRole, "Manual role"); assert.equal(company.owner, "Original owner"); assert.equal(company.dataClass, "real");
    assert.equal(company.market, "Private market"); assert.equal(company.contacts.length, 3); assert.equal(company.contacts[0].role, "Manually confirmed purchasing contact"); assert.equal(saved.state.inquiries.length, 1); assert.equal(company.researchStatus, "not_started");
    const revision = company.revision;
    assert.equal((await attachCompanyWebsite(payload)).result.duplicate, true); assert.equal((await readPlatform()).companies[0].revision, revision);
    await act("update_company", { id, expectedRevision: revision, website: "https://replacement.test" });
    assert.equal((await attachCompanyWebsite(payload)).result.duplicate, true); assert.equal((await readPlatform()).companies[0].website, "https://replacement.test/");
    await assert.rejects(planCompanyWebsite({ companyId: id }), error => error.code === "WEBSITE_ALREADY_PRESENT");
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("No name evidence, duplicate final domain, stale company and spoofed new evidence cannot attach", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    const id = await seed(), result = await checked(id), payload = attachment(result);
    await assert.rejects(attachCompanyWebsite({ ...payload, expectedRevision: 99 }), error => error.code === "REVISION_CONFLICT");
    await assert.rejects(attachCompanyWebsite({ ...payload, contacts: [{ type: "email", value: "fake@example.test" }] }));
    await act("create_company", { name: "Domain belongs elsewhere", website: "https://example-brakes.test" });
    await assert.rejects(attachCompanyWebsite(payload), error => error.code === "DUPLICATE_COMPANY");
    await act("update_company", { id, expectedRevision: 1, name: "Different name" });
    await assert.rejects(attachCompanyWebsite(payload), error => error.code === "WEBSITE_COMPANY_CHANGED");
    assert.equal((await readPlatform()).companies[0].website, "");
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Private redirect and absent actual name fail closed without requesting private host or attaching search snippet", async () => {
  const db = await database(); const fetched = [];
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    globalThis.fetch = async url => {
      fetched.push(String(url));
      if (String(url).includes("api.tavily.com")) return response([hit("https://redirect.test"), hit("https://no-name.test")]);
      if (String(url).includes("redirect.test")) return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
      return new Response("<title>Other company</title><main>Completely different name</main>", { headers: { "content-type": "text/html" } });
    };
    const run = (await search(id)).result.run;
    const blocked = (await inspectCompanyWebsite({ runId: run.id, candidateId: run.candidates[0].id })).result;
    assert.equal(blocked.candidate.status, "blocked"); assert.equal(blocked.candidate.evidence.length, 0); assert.ok(fetched.every(url => !url.includes("127.0.0.1")));
    const missing = (await inspectCompanyWebsite({ runId: run.id, candidateId: run.candidates[1].id })).result;
    assert.equal(missing.candidate.status, "needs_evidence"); await assert.rejects(attachCompanyWebsite(attachment(missing)), error => error.code === "WEBSITE_IDENTITY_EVIDENCE_REQUIRED");
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Website and buyer searches share six-run budget and in-flight guard; concurrent reservation cannot spend twice", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    const id = await seed(); globalThis.fetch = async () => { calls++; return response([]); };
    const pair = await Promise.allSettled([search(id), search(id)]);
    assert.equal(pair.filter(item => item.status === "fulfilled").length, 1); assert.equal(calls, 2);
    await mutatePlatform(state => { for (let i = 0; i < 5; i++) state.discoveryRuns.push({ id: "prior-" + i, status: "failed", startedAt: new Date().toISOString() }); });
    await assert.rejects(search(id, { name: "Example Brakes Ltd", country: "New country" }), error => error.code === "DISCOVERY_DAILY_LIMIT");
    const criteria = { productId: "", category: "brake_lining", targetMarket: "UK", buyerRoles: ["distributor"], extraTerms: "", excludedTerms: "" };
    const plan = await planBuyerDiscovery({ seedCompanyId: id, criteria });
    await assert.rejects(searchMoreBuyers({ seedCompanyId: id, criteria, planHash: plan.planHash, confirmed: true }), error => error.code === "DISCOVERY_DAILY_LIMIT");
    await mutatePlatform(state => { state.discoveryRuns = []; state.websiteResolutionRuns[0].status = "searching"; state.websiteResolutionRuns[0].startedAt = new Date().toISOString(); });
    await assert.rejects(searchMoreBuyers({ seedCompanyId: id, criteria, planHash: plan.planHash, confirmed: true }), error => error.code === "DISCOVERY_IN_PROGRESS");
    assert.equal(calls, 2);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("User-provided URL reads at most two actual pages without search calls even after quota exhaustion; source/cache/attach are explicit", async () => {
  const db = await database(); const calls = [];
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    await mutatePlatform(state => { for (let i = 0; i < 6; i++) state.discoveryRuns.push({ id: "search-used-" + i, status: "failed", startedAt: new Date().toISOString() }); });
    globalThis.fetch = async url => { calls.push(String(url)); assert.ok(!String(url).includes("tavily")); return html('<main>Example Brakes Ltd <a href="/contact">Contact</a><a href="/about">About</a><a href="mailto:info@example-brakes.test">Email</a></main>'); };
    const payload = { mode: "inspect_url", companyId: id, criteria: { name: "Example Brakes Ltd", country: "UK" }, url: "https://example-brakes.test/#review", expectedRevision: 1, confirmed: true };
    const checked = await inspectCompanyWebsiteUrl(payload);
    assert.equal(calls.length, 2); assert.equal(checked.result.run.sourceKind, "manual_url"); assert.equal(checked.result.run.provider, "用户提供官网"); assert.deepEqual(checked.result.run.queries, []);
    assert.equal(checked.result.run.modelCalls, 0); assert.equal(checked.result.run.status, "complete"); assert.equal(checked.result.candidate.status, "needs_review");
    assert.equal(checked.result.candidate.contacts[0].sourceUrl, "https://example-brakes.test/");
    const cached = await inspectCompanyWebsiteUrl(payload); assert.equal(cached.result.cached, true); assert.equal(calls.length, 2); assert.equal(cached.result.run.id, checked.result.run.id);
    const saved = await attachCompanyWebsite(attachment(checked.result, "manual-attach"));
    assert.equal(saved.state.companies[0].websiteResolution.sourceKind, "manual_url"); assert.equal(saved.state.companies[0].grade, "A");
    assert.equal((await attachCompanyWebsite(attachment(checked.result, "manual-attach"))).result.duplicate, true);
    assert.equal(calls.length, 2);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Manual URLs preserve URL safety, revision and owner gates; failed reads cannot become successful search or attach", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    const id = await seed(), base = { companyId: id, criteria: { name: "Example Brakes Ltd", country: "" }, url: "https://example-brakes.test", expectedRevision: 1, confirmed: true };
    globalThis.fetch = async () => { calls++; return new Response("blocked", { status: 403 }); };
    for (const url of ["http://127.0.0.1/", "http://192.168.1.1/", "https://linkedin.com/company/anything", "file:///etc/passwd"]) await assert.rejects(inspectCompanyWebsiteUrl({ ...base, url }));
    await assert.rejects(inspectCompanyWebsiteUrl({ ...base, expectedRevision: 99 }), error => error.code === "REVISION_CONFLICT");
    await assert.rejects(withPlatformContext(context(db, "v:other-owner"), () => inspectCompanyWebsiteUrl(base)), error => error.code === "WEBSITE_COMPANY_NOT_FOUND");
    assert.equal(calls, 0); assert.equal((await readPlatform()).websiteResolutionRuns.length, 0);
    const result = (await inspectCompanyWebsiteUrl(base)).result;
    assert.equal(calls, 1); assert.equal(result.run.status, "failed"); assert.equal(result.run.queries.length, 0); assert.equal(result.candidate.status, "blocked"); assert.equal(result.candidate.evidence.length, 0);
    await assert.rejects(attachCompanyWebsite(attachment(result, "blocked-manual")), error => error.code === "WEBSITE_IDENTITY_EVIDENCE_REQUIRED");
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Manual URL records do not consume or block actual public search slots", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    await mutatePlatform(state => { for (let i = 0; i < 8; i++) state.websiteResolutionRuns.push({ id: "manual-" + i, sourceKind: "manual_url", status: "searching", startedAt: new Date().toISOString() }); });
    globalThis.fetch = async () => { calls++; return response([]); };
    assert.equal((await search(id)).result.run.status, "complete"); assert.equal(calls, 2);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});
