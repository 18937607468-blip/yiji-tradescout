import test from "node:test";
import { saveSearchKey } from "../lib/platform/search-config.mjs";
const fakeKey = "tvly-test-SYNTHETIC-NOT-REAL-0123456789";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { withPlatformContext } from "../lib/platform/context.mjs";
import { readPlatform, mutatePlatform } from "../lib/platform/store.mjs";
import { act } from "../lib/platform/domain.mjs";
import { planBuyerDiscovery, searchMoreBuyers, inspectBuyerCandidate, reassessBuyerCandidate, saveBuyerCandidate, inspectDiscoveryEvidence, searchPublicCandidates, discoveryPageEvidence, prescreenDiscoveryCandidate } from "../lib/platform/buyer-discovery.mjs";
import { assessCompanyHs, CUSTOMS_QA_SOURCE_URL } from "../lib/platform/customs-catalog.mjs";

async function database() {
  const raw = new DatabaseSync(":memory:");
  for (const file of (await readdir(new URL("../drizzle/", import.meta.url))).filter(value => value.endsWith(".sql")).sort()) raw.exec(await readFile(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  return { raw, prepare(query) { return { bind(...values) { return { async first() { return raw.prepare(query).get(...values) || null; }, async run() { const result = raw.prepare(query).run(...values); return { meta: { changes: Number(result.changes) } }; } }; } }; } };
}
const context = (db, ownerId = "v:discovery-test") => ({ db, ownerId, authenticated: true, dataKey: Buffer.alloc(32, 17).toString("base64url") });
const product = { id: "lining", name: "Truck brake lining WVA 19488", category: "brake_lining", codes: [{ namespace: "WVA", value: "19488" }, { namespace: "OE", value: "UNPROVEN123" }] };
const criteria = { productId: "lining", category: "brake_lining", targetMarket: "Thailand", buyerRoles: ["importer", "distributor"], extraTerms: "", excludedTerms: "passenger car" };
async function seed() {
  await saveSearchKey(fakeKey);
  let state = await act("create_company", { name: "Synthetic reference", website: "https://seed.example", market: "Private unconfirmed market", notes: "Private financial and customer chat material MUST NEVER BE SEARCHED" });
  const id = state.companies[0].id;
  await mutatePlatform(value => { value.products.push(structuredClone(product)); value.companies[0].productRefs = ["WVA 19488"]; value.companies[0].isDemo = true; });
  return id;
}
const response = results => Response.json({ request_id: "test-provider-request", results, usage: { credits: 0 } });
const hit = (url, title = "Synthetic test company") => ({ url, title, content: "Search snippet about truck brake lining. It is not fetched website evidence." });
async function search(seedCompanyId, overrides = {}) {
  const plan = await planBuyerDiscovery({ seedCompanyId, criteria: { ...criteria, ...overrides } });
  return searchMoreBuyers({ seedCompanyId, criteria: plan.criteria, planHash: plan.planHash, confirmed: true });
}
const originalFetch = globalThis.fetch;

test("Discovery plan sends only reviewed public terms and rejects stale/unconfirmed conditions", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    const defaultPlan = await planBuyerDiscovery({ seedCompanyId: id });
    assert.equal(defaultPlan.criteria.targetMarket, ""); assert.equal(defaultPlan.criteria.productId, "lining");
    const plan = await planBuyerDiscovery({ seedCompanyId: id, criteria });
    assert.equal(plan.queries.length, 2); assert.ok(plan.queries.some(query => query.includes("WVA 19488")));
    assert.ok(plan.queries.every(query => !query.includes("Private") && !query.includes("Synthetic reference")));
    await assert.rejects(() => searchMoreBuyers({ seedCompanyId: id, criteria, planHash: plan.planHash }), error => error.code === "DISCOVERY_CONFIRM_REQUIRED");
    await assert.rejects(() => searchMoreBuyers({ seedCompanyId: id, criteria: { ...criteria, targetMarket: "Mexico" }, planHash: plan.planHash, confirmed: true }), error => error.code === "DISCOVERY_PLAN_CHANGED");
    assert.equal((await readPlatform()).discoveryRuns.length, 0);
  }); } finally { db.raw.close(); }
});

test("Runtime search uses the real provider contract and validates failed/malformed responses", async () => {
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return response([hit("https://candidate.example")]); };
    const result = await searchPublicCandidates("truck brake lining importer", { apiKey: fakeKey });
    assert.equal(result.results.length, 1); assert.equal(result.requestId, "test-provider-request");
    assert.equal(calls[0].url, "https://api.tavily.com/search");
    assert.equal(calls[0].options.headers.Authorization, "Bearer " + fakeKey);
    assert.equal(calls[0].options.redirect, "manual");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.search_depth, "basic"); assert.equal(body.max_results, 10); assert.equal(body.include_answer, false); assert.equal(body.include_raw_content, false); assert.equal(body.auto_parameters, false);
    globalThis.fetch = async () => new Response("Rate limited", { status: 429 });
    await assert.rejects(() => searchPublicCandidates("other query", { apiKey: fakeKey }), error => error.code === "SEARCH_RATE_LIMIT");
    let redirectCalls = 0;
    globalThis.fetch = async () => { redirectCalls++; return new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } }); };
    await assert.rejects(() => searchPublicCandidates("other query", { apiKey: fakeKey }), error => error.code === "SEARCH_PROVIDER_ERROR" && error.message.includes("307"));
    assert.equal(redirectCalls, 1);
    globalThis.fetch = async () => Response.json({});
    await assert.rejects(() => searchPublicCandidates("other query", { apiKey: fakeKey }), error => error.code === "SEARCH_INVALID_RESPONSE");
    globalThis.fetch = async () => Response.json({ results: [{ title: "malformed", url: null }] });
    await assert.rejects(() => searchPublicCandidates("other query", { apiKey: fakeKey }), error => error.code === "SEARCH_INVALID_RESPONSE");
  } finally { globalThis.fetch = originalFetch; }
});

test("Search deduplicates domains, seed, existing customers and restricted/private sources; cache spends no new calls", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    await act("create_company", { name: "Existing protected customer", website: "https://known.example", grade: "A", owner: "Original owner", stage: "成交/维护" });
    globalThis.fetch = async () => { calls++; return response([hit("https://seed.example/product"), hit("https://known.example"), hit("https://new.example/p"), hit("https://www.new.example/p2"), hit("https://linkedin.com/company/test"), hit("http://127.0.0.1/")]); };
    const first = await search(id);
    assert.equal(calls, 2); assert.equal(first.result.run.candidates.length, 1); assert.equal(first.result.run.candidates[0].domain, "new.example");
    assert.equal(first.result.run.candidates[0].evidence.length, 0); assert.equal(first.result.run.candidates[0].status, "unverified");
    assert.equal(first.result.run.dataClass, "real"); assert.equal(first.result.run.modelCalls, 0);
    const cached = await search(id); assert.equal(cached.result.cached, true); assert.equal(calls, 2);
    const existing = cached.state.companies.find(item => item.name === "Existing protected customer"); assert.equal(existing.grade, "A"); assert.equal(existing.owner, "Original owner");
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Partial search retains successful query results while provider failure is distinct from no matches", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    globalThis.fetch = async () => ++calls % 2 ? response([hit("https://partial.example")]) : new Response("unavailable", { status: 503 });
    let result = await search(id); assert.equal(result.result.run.status, "partial"); assert.equal(result.result.run.candidates.length, 1); assert.equal(result.result.run.queries.filter(query => query.status === "failed").length, 1);
    globalThis.fetch = async () => new Response("limited", { status: 429 });
    result = await search(id, { targetMarket: "Mexico" }); assert.equal(result.result.run.status, "failed"); assert.equal(result.result.run.candidates.length, 0);
    globalThis.fetch = async () => response([]);
    result = await search(id, { targetMarket: "Finland" }); assert.equal(result.result.run.status, "complete"); assert.equal(result.result.run.candidates.length, 0);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Evidence gates reject manufacturers' customer descriptions, passenger use and mismatched code namespace", () => {
  const source = snippet => [{ id: "page", snippet }];
  const valid = inspectDiscoveryEvidence(source("We are an importer and wholesale distributor. We import truck brake linings with WVA 19488. Our inventory includes commercial vehicle brake lining products."), product);
  assert.ok(valid.productEvidence.length); assert.ok(valid.roleEvidence.length);
  const manufacturer = inspectDiscoveryEvidence(source("We manufacture truck brake lining products and supply to distributors. Our customers are wholesalers and importers."), product);
  assert.ok(manufacturer.productEvidence.length); assert.equal(manufacturer.roleEvidence.length, 0);
  const recruitment = inspectDiscoveryEvidence(source("We manufacture truck brake linings. Become a distributor. Apply to join our worldwide dealer network."), product);
  assert.ok(recruitment.productEvidence.length); assert.equal(recruitment.roleEvidence.length, 0);
  const passenger = inspectDiscoveryEvidence(source("We are a distributor of brake linings WVA 19488 for passenger cars only, not for commercial vehicles."), product);
  assert.equal(passenger.productEvidence.length, 0);
  const namespace = inspectDiscoveryEvidence(source("We are a distributor. Our INTERNAL 19488 is a generic industrial friction item."), product);
  assert.equal(namespace.productEvidence.filter(item => item.relationship === "same_code").length, 0);
});

test("Actual page inspection, explicit save, source hashes and per-workspace isolation preserve truthful leads", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    globalThis.fetch = async () => response([hit("https://new.example/brakes")]);
    const found = await search(id), runId = found.result.run.id, candidateId = found.result.run.candidates[0].id;
    await assert.rejects(() => saveBuyerCandidate({ runId, candidateId, companyName: "New Buyer", confirmIdentity: true, expectedCandidateHash: "a".repeat(64) }), error => error.code === "DISCOVERY_EVIDENCE_REQUIRED");
    globalThis.fetch = async url => new Response('<html><title>New Buyer test website</title><body><p>We are an importer and wholesale distributor.</p><p>We import truck brake linings WVA 19488. Commercial vehicle brake lining is our product line.</p></body></html>', { headers: { "content-type": "text/html" } });
    const inspected = await inspectBuyerCandidate({ runId, candidateId });
    assert.equal(inspected.result.candidate.status, "related_evidence"); assert.equal(inspected.result.candidate.pagesFetched, 1); assert.equal(inspected.result.candidate.evidence[0].type, "webpage");
    await assert.rejects(() => saveBuyerCandidate({ runId, candidateId, companyName: "New Buyer", confirmIdentity: true, expectedCandidateHash: "a".repeat(64) }), error => error.code === "DISCOVERY_CANDIDATE_CHANGED");
    await assert.rejects(() => saveBuyerCandidate({ runId, candidateId: "fabricated", companyName: "New Buyer", confirmIdentity: true, expectedCandidateHash: "a".repeat(64) }), error => error.code === "DISCOVERY_CANDIDATE_NOT_FOUND");
    const saveInput = { runId, candidateId, companyName: "New Buyer", confirmIdentity: true, expectedCandidateHash: inspected.result.candidate.candidateHash };
    let saved = await saveBuyerCandidate(saveInput); const company = saved.state.companies.find(item => item.id === saved.result.companyId);
    assert.equal(company.market, ""); assert.equal(company.dataClass, "real"); assert.equal(company.isDemo, false); assert.equal(company.grade, "unknown");
    assert.deepEqual(company.productRefs, ["WVA 19488"]); assert.ok(company.notes.includes("Thailand")); assert.ok(company.evidence.length); assert.equal(company.contacts.length, 0);
    saved = await saveBuyerCandidate(saveInput); assert.equal(saved.result.duplicate, true); assert.equal(saved.state.companies.filter(item => item.name === "New Buyer").length, 1);
    await act("update_company", { id: company.id, expectedRevision: company.revision, website: "https://moved.example" });
    saved = await saveBuyerCandidate(saveInput); assert.equal(saved.result.duplicate, true); assert.equal(saved.state.companies.filter(item => item.name === "New Buyer").length, 1); assert.equal(saved.state.companies.find(item => item.id === company.id).website, "https://moved.example/");
    await withPlatformContext(context(db, "v:another-user"), async () => { await assert.rejects(() => inspectBuyerCandidate({ runId, candidateId }), error => error.code === "DISCOVERY_RUN_NOT_FOUND"); await assert.rejects(() => saveBuyerCandidate(saveInput), error => error.code === "DISCOVERY_RUN_NOT_FOUND"); });
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Failed website inspection never promotes snippets; a newly-existing company is never overwritten on save", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    const id = await seed(); globalThis.fetch = async () => response([hit("https://blocked.example"), hit("https://late.example")]);
    const found = await search(id), runId = found.result.run.id;
    globalThis.fetch = async () => new Response("Forbidden", { status: 403 });
    let result = await inspectBuyerCandidate({ runId, candidateId: found.result.run.candidates[0].id }); assert.equal(result.result.candidate.status, "blocked"); assert.equal(result.result.candidate.evidence.length, 0);
    globalThis.fetch = async () => new Response("We sell generic industrial products.", { headers: { "content-type": "text/plain" } });
    result = await inspectBuyerCandidate({ runId, candidateId: found.result.run.candidates[1].id }); assert.equal(result.result.candidate.status, "needs_evidence");
    await act("create_company", { name: "Sales already added this", website: "https://late.example", grade: "A", owner: "Existing salesperson", stage: "报价沟通" });
    const saved = await saveBuyerCandidate({ runId, candidateId: result.result.candidate.id, companyName: "Should not overwrite", confirmIdentity: true, expectedCandidateHash: result.result.candidate.candidateHash });
    assert.equal(saved.result.duplicate, true); const company = saved.state.companies.find(item => item.id === saved.result.companyId); assert.equal(company.grade, "A"); assert.equal(company.owner, "Existing salesperson"); assert.equal(company.name, "Sales already added this");
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Per-workspace daily search cap stops before additional provider calls", async () => {
  const db = await database(); let calls = 0;
  try { await withPlatformContext(context(db), async () => {
    const id = await seed(); globalThis.fetch = async () => { calls++; return response([]); };
    for (let index = 0; index < 6; index++) await search(id, { extraTerms: "batch " + index });
    assert.equal(calls, 12); await assert.rejects(() => search(id, { extraTerms: "batch 7" }), error => error.code === "DISCOVERY_DAILY_LIMIT"); assert.equal(calls, 12);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Enterprise HS catalogue keeps raw codes, ambiguous HS6 and unsupported clutch separate", () => {
  const original = assessCompanyHs("6813.81 00 00");
  assert.equal(original.rawCode, "6813.81 00 00"); assert.equal(original.normalizedCode, "6813810000"); assert.equal(original.hs6, "681381"); assert.equal(original.options[0].category, "brake_lining");
  assert.equal(original.options[0].sourceUrl, CUSTOMS_QA_SOURCE_URL); assert.equal(original.matchLevel, "company_code");
  const ambiguous = assessCompanyHs("870830"); assert.equal(ambiguous.ambiguous, true); assert.deepEqual(ambiguous.options.map(item => item.category), ["disc_brake_pad", "brake_shoe"]);
  assert.equal(assessCompanyHs("87083099").options[0].category, "disc_brake_pad"); assert.equal(assessCompanyHs("8708301000").options[0].category, "brake_shoe");
  assert.equal(assessCompanyHs("6813890000").options[0].supported, false); assert.equal(assessCompanyHs("6813890000").options[0].category, "clutch_facing");
  assert.equal(assessCompanyHs("8708301234").ambiguous, true); assert.equal(assessCompanyHs("8708301234").matchLevel, "hs6");
  assert.equal(assessCompanyHs("001234").normalizedCode, "001234"); assert.equal(assessCompanyHs("001234").options.length, 0);
  for (const raw of ["8708", "8708301", "870830999000", "8.7083E+05", "870830x", "......"]) assert.equal(assessCompanyHs(raw).formatValid, false, raw);
  assert.equal(assessCompanyHs("").formatValid, true);
});

test("HS plans surface only this seed's source rows and never send source cargo/private material to search", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    await mutatePlatform(state => {
      state.customsRecords.push({ id: "customs-source-one", companyId: id, sourceName: "Authorized export.csv", row: 12, hsCode: "6813.81 00 00", description: "INTERNAL cargo marker and purchasing note", country: "Thailand", dataClass: "real" });
      state.customsRecords.push({ id: "other-company-source", companyId: "other-company", sourceName: "Other file", row: 5, hsCode: "870830", description: "Other company private cargo", country: "Mexico", dataClass: "real" });
    });
    const defaultPlan = await planBuyerDiscovery({ seedCompanyId: id });
    assert.equal(defaultPlan.criteria.hsCode, ""); assert.equal(defaultPlan.criteria.targetMarket, ""); assert.equal(defaultPlan.customsHints.length, 1); assert.equal(defaultPlan.customsHintCount, 1);
    assert.equal(defaultPlan.customsHints[0].sourceRow, 12); assert.equal(defaultPlan.customsHints[0].hsCode, "6813.81 00 00"); assert.equal(defaultPlan.customsHints[0].country, "Thailand");
    const plan = await planBuyerDiscovery({ seedCompanyId: id, criteria: { ...criteria, hsCode: "6813.81 00 00" } });
    assert.equal(plan.criteria.hsCode, "6813.81 00 00"); assert.ok(plan.queries[1].includes('"HS 681381"')); assert.ok(!plan.queries[0].includes("681381")); assert.equal(plan.queries.length, 2);
    assert.ok(plan.queries.every(query => !query.includes("INTERNAL") && !query.includes("Private") && !query.includes("Authorized export") && !query.includes("purchasing note")));
    assert.ok(plan.warnings.some(value => value.includes("不查询海关数据库")));
    await withPlatformContext(context(db, "v:different-workspace"), async () => { await assert.rejects(() => planBuyerDiscovery({ seedCompanyId: id }), error => error.code === "DISCOVERY_SEED_NOT_FOUND"); });
  }); } finally { db.raw.close(); }
});

test("Ambiguous HS requires deliberate category choice and conflicts are rejected before search", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    const base = { ...criteria, productId: "", category: "disc_brake_pad", hsCode: "870830" };
    await assert.rejects(() => planBuyerDiscovery({ seedCompanyId: id, criteria: base }), error => error.code === "DISCOVERY_HS_CATEGORY_REQUIRED");
    const pad = await planBuyerDiscovery({ seedCompanyId: id, criteria: { ...base, hsCategoryConfirmed: true } }); assert.equal(pad.criteria.category, "disc_brake_pad"); assert.equal(pad.hsAssessment.options.length, 2);
    const shoe = await planBuyerDiscovery({ seedCompanyId: id, criteria: { ...base, category: "brake_shoe", hsCategoryConfirmed: true } }); assert.equal(shoe.criteria.category, "brake_shoe"); assert.notEqual(shoe.planHash, pad.planHash);
    await assert.rejects(() => planBuyerDiscovery({ seedCompanyId: id, criteria: { ...criteria, hsCode: "8708309990" } }), error => error.code === "DISCOVERY_HS_CATEGORY_MISMATCH");
    await assert.rejects(() => planBuyerDiscovery({ seedCompanyId: id, criteria: { ...criteria, hsCode: "6813890000" } }), error => error.code === "DISCOVERY_HS_UNSUPPORTED");
    await assert.rejects(() => planBuyerDiscovery({ seedCompanyId: id, criteria: { ...criteria, hsCode: "6813" } }), error => error.code === "DISCOVERY_HS_FORMAT");
    assert.equal((await readPlatform()).discoveryRuns.length, 0);
  }); } finally { db.raw.close(); }
});

test("HS changes invalidate old plans and cached searches without spending on stale requests", async () => {
  const db = await database(); let calls = 0; const sent = [];
  try { await withPlatformContext(context(db), async () => {
    const id = await seed();
    globalThis.fetch = async (url, options) => { calls++; sent.push(JSON.parse(options.body).query); return response([]); };
    const withoutHs = await planBuyerDiscovery({ seedCompanyId: id, criteria });
    await assert.rejects(() => searchMoreBuyers({ seedCompanyId: id, criteria: { ...criteria, hsCode: "681381" }, planHash: withoutHs.planHash, confirmed: true }), error => error.code === "DISCOVERY_PLAN_CHANGED"); assert.equal(calls, 0);
    const first = await search(id); assert.equal(first.result.cached, false); assert.equal(calls, 2);
    const withHs = await search(id, { hsCode: "681381" }); assert.equal(withHs.result.cached, false); assert.equal(calls, 4); assert.ok(sent[3].includes("HS 681381")); assert.ok(!sent[2].includes("HS 681381"));
    const again = await search(id, { hsCode: "681381" }); assert.equal(again.result.cached, true); assert.equal(calls, 4);
    assert.equal(withHs.result.run.criteria.hsCode, "681381"); assert.notEqual(first.result.run.inputHash, withHs.result.run.inputHash);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Sentence evidence recognizes the site's appointed distributor, not third-party, recruitment or negative roles", () => {
  const sentence = "Roadlink has recently been appointed as UK distributor for the range of Ferodo branded CV, PCV and LCV braking products.";
  const source = (snippet, url = "https://roadlink.co.uk/about") => [{ id: "roadlink", url, title: "Roadlink", snippet }];
  const found = inspectDiscoveryEvidence(source(sentence), product);
  assert.equal(found.roleEvidence.length, 1); assert.equal(found.roleEvidence[0].quote, sentence);
  assert.equal(inspectDiscoveryEvidence(source("The Roadlink Company Ltd is a distributor of truck brake linings."), product).roleEvidence.length, 1);
  for (const explicitRole of [
    "Northward Solutions are pleased to announce that we are an official distributor and stockist of Truck-Lite products.",
    "we are now official distributors of: Lumag",
    "We are currently approved importers of commercial vehicle brake linings.",
    "We are also approved wholesalers of truck brake linings."
  ]) assert.equal(inspectDiscoveryEvidence(source(explicitRole, "https://northward.example/about"), product).roleEvidence.length, 1, explicitRole);
  assert.equal(inspectDiscoveryEvidence(source(sentence, "https://unrelated-manufacturer.example"), product).roleEvidence.length, 0);
  for (const rejected of [
    "Our partner Roadlink has recently been appointed as UK distributor for Ferodo.",
    "Our customers are distributors of commercial vehicle brake linings.",
    "ACME, unlike Roadlink, is a distributor of truck brake linings.",
    "The company next door to Roadlink is a distributor of truck brake linings.",
    "Roadlink's partner is a distributor of truck brake linings.",
    "Roadlink is no longer a distributor of truck brake linings.",
    "Become a distributor of truck brake linings. Apply to join our dealer network.",
    "We manufacture truck brake linings and sell to distributors."
  ]) assert.equal(inspectDiscoveryEvidence(source(rejected), product).roleEvidence.length, 0, rejected);
  const mixed = inspectDiscoveryEvidence(source("We manufacture commercial vehicle brake linings. We are an importer and distributor of truck brake linings."), product);
  assert.ok(mixed.roleEvidence.length); assert.ok(mixed.productEvidence.length);
  const body = discoveryPageEvidence({ url: "https://roadlink.co.uk/products", title: "Roadlink", html: '<nav>Truck brake lining WVA 19488 distributor <a href="/catalog">Products</a></nav><main><p>Our truck brake linings include WVA 19488.</p></main>' });
  assert.equal(body.snippet, "Our truck brake linings include WVA 19488.");
  assert.ok(inspectDiscoveryEvidence([body], product).productEvidence.every(item => item.quote === body.snippet));
  assert.equal(prescreenDiscoveryCandidate("Truck brake linings distributor", "brake_lining").priority, "first");
  assert.equal(prescreenDiscoveryCandidate("Truck brake linings manufacturer", "brake_lining").priority, "normal");
  assert.equal(prescreenDiscoveryCandidate("Generic manufacturer", "brake_lining").basis, "search_snippet");
});

test("Inspection reads at most product, about and contact pages; public contacts retain source and save idempotently", async () => {
  const db = await database(), calls = [];
  try { await withPlatformContext(context(db), async () => {
    const id = await seed(); globalThis.fetch = async () => response([hit("https://roadlink.co.uk/brakes")]);
    const found = await search(id), runId = found.result.run.id, candidateId = found.result.run.candidates[0].id;
    const pages = {
      "/brakes": '<nav>Products distributor catalogue</nav><main><p>Our commercial vehicle truck brake linings include WVA 19488.</p></main><a href="/about">About us</a><a href="/about-history">Company history</a><a href="/contact">Contact us</a><a href="/contact#top">Contact again</a><a href="mailto:sales@roadlink.co.uk">Sales</a>',
      "/about": '<main><p>Roadlink has recently been appointed as UK distributor for the range of Ferodo branded CV, PCV and LCV braking products.</p></main>',
      "/contact": '<main><p>Contact Roadlink</p><a href="mailto:sales@roadlink.co.uk">Sales</a><a href="tel:+441234567890">Telephone</a><a href="https://wa.me/441234567891">WhatsApp</a></main>'
    };
    globalThis.fetch = async url => { calls.push(String(url)); const html = pages[new URL(url).pathname]; assert.ok(html, "Unexpected page: " + url); return new Response(html, { headers: { "content-type": "text/html" } }); };
    const inspected = await inspectBuyerCandidate({ runId, candidateId }), candidate = inspected.result.candidate;
    assert.equal(candidate.status, "related_evidence"); assert.equal(candidate.pagesFetched, 3);
    assert.deepEqual(calls, ["https://roadlink.co.uk/brakes", "https://roadlink.co.uk/about", "https://roadlink.co.uk/contact"]);
    assert.equal(candidate.contacts.length, 3); assert.equal(candidate.contacts.filter(item => item.type === "email").length, 1);
    assert.ok(candidate.contacts.every(item => item.sourceUrl === "https://roadlink.co.uk/contact" && item.verification === "public_page" && item.role.includes("未确认")));
    assert.ok(candidate.contacts.some(item => item.type === "url" && item.value === "https://wa.me/441234567891"));
    const input = { runId, candidateId, companyName: "Roadlink", confirmIdentity: true, expectedCandidateHash: candidate.candidateHash };
    const saved = await saveBuyerCandidate(input), company = saved.state.companies.find(item => item.id === saved.result.companyId);
    assert.equal(company.contacts.length, 3); assert.equal(company.grade, "unknown"); assert.equal(company.market, "");
    const again = await saveBuyerCandidate(input); assert.equal(again.result.duplicate, true); assert.equal(again.state.companies.find(item => item.id === company.id).contacts.length, 3);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("Reassessing stored evidence uses no network or quota, invents no old contacts, and leaves saved customer untouched", async () => {
  const db = await database(); let networkCalls = 0;
  try { await withPlatformContext(context(db), async () => {
    const id = await seed(); globalThis.fetch = async () => response([hit("https://roadlink.co.uk/brakes")]);
    const found = await search(id), runId = found.result.run.id, candidateId = found.result.run.candidates[0].id;
    globalThis.fetch = async () => new Response('<main><p>Our truck brake linings include WVA 19488.</p><p>Roadlink has recently been appointed as UK distributor for Ferodo braking products.</p></main>', { headers: { "content-type": "text/html" } });
    const inspected = await inspectBuyerCandidate({ runId, candidateId });
    const saved = await saveBuyerCandidate({ runId, candidateId, companyName: "Roadlink", confirmIdentity: true, expectedCandidateHash: inspected.result.candidate.candidateHash });
    const before = structuredClone(saved.state.companies.find(item => item.id === saved.result.companyId));
    await mutatePlatform(state => { const run = state.discoveryRuns.find(item => item.id === runId), candidate = run.candidates[0]; run.inspectionCount = 3; candidate.roleEvidence = []; candidate.status = "needs_evidence"; delete candidate.contacts; delete candidate.inspectionRuleVersion; });
    globalThis.fetch = async () => { networkCalls++; throw new Error("Reassessment must not fetch"); };
    const reassessed = await reassessBuyerCandidate({ runId, candidateId });
    assert.equal(networkCalls, 0); assert.equal(reassessed.result.run.inspectionCount, 3); assert.equal(reassessed.result.candidate.status, "related_evidence"); assert.deepEqual(reassessed.result.candidate.contacts, []);
    assert.deepEqual(reassessed.state.companies.find(item => item.id === before.id), before);
    await withPlatformContext(context(db, "v:other-workspace"), async () => { await assert.rejects(() => reassessBuyerCandidate({ runId, candidateId }), error => error.code === "DISCOVERY_RUN_NOT_FOUND"); });
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});
