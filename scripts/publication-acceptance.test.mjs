// Synthetic fixtures only. All provider/website responses are mocked explicitly.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { withPlatformContext } from "../lib/platform/context.mjs";
import { readPlatform, readRaw } from "../lib/platform/store.mjs";
import { act, importCompanies } from "../lib/platform/domain.mjs";
import { validateResearch, researchCompany } from "../lib/platform/research.mjs";
import { saveModelKey } from "../lib/platform/model-config.mjs";
import { saveSearchKey } from "../lib/platform/search-config.mjs";
import { planBuyerDiscovery, searchMoreBuyers, inspectBuyerCandidate, saveBuyerCandidate, searchPublicCandidates } from "../lib/platform/buyer-discovery.mjs";
import { planCompanyWebsite, searchCompanyWebsite, inspectCompanyWebsiteUrl } from "../lib/platform/company-website.mjs";

function database() {
  const raw = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter(f => f.endsWith(".sql")).sort()) raw.exec(readFileSync(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  return { raw, prepare(query) { return { bind(...values) { return {
    async first() { return raw.prepare(query).get(...values) || null; },
    async run() { return { meta: { changes: Number(raw.prepare(query).run(...values).changes) } }; },
  }; } }; } };
}
const ctx = (db, ownerId = "u:acceptance-a") => ({ db, ownerId, authenticated: true, dataKey: Buffer.alloc(32, 19).toString("base64url") });
const originalFetch = globalThis.fetch;
const source = "We are an importer and distributor of truck brake linings. We import truck brake linings WVA 19488.";
const html = () => new Response(`<html><title>Synthetic Brakes</title><main>${source}<a href="mailto:sales@synthetic.example">Contact</a></main></html>`, { headers: { "content-type": "text/html" } });
const criteria = { productId: "", category: "brake_lining", targetMarket: "UK", buyerRoles: ["importer"], extraTerms: "", excludedTerms: "" };
async function search(id, patch = {}) {
  const plan = await planBuyerDiscovery({ seedCompanyId: id, criteria: { ...criteria, ...patch } });
  return searchMoreBuyers({ seedCompanyId: id, criteria: plan.criteria, planHash: plan.planHash, confirmed: true });
}
function output(facts = [], extra = {}) { return { websiteFacts: facts, productMatches: [], openingQuestion: null, unknowns: [], recommendedNextAction: "人工确认需求", ...extra }; }

test("A: fabricated transaction, email, price, reference and buyer roles are not accepted as facts", () => {
  const sources = [{ id: "page", snippet: source }];
  const fact = value => ({ field: "products", sourceId: "page", quote: source, value });
  for (const value of ["客户已下单200片", "客户近期采购意向明确", "联系 invented@other.example", "单价 USD 12345"]) {
    assert.throws(() => validateResearch(JSON.stringify(output([fact(value)])), sources, []), e => ["UNSUPPORTED_TRANSACTION", "UNSUPPORTED_CONTACT_OR_PRICE"].includes(e.code));
  }
  assert.throws(() => validateResearch(JSON.stringify(output([{ ...fact("产品"), sourceId: "invented" }])), sources, []), e => e.code === "UNSUPPORTED_FACT");
  const quote = "We manufacture products and sell to distributors.";
  const rejected = validateResearch(JSON.stringify(output([{ field: "buyer_role", value: "进口买家", sourceId: "maker", quote }])), [{ id: "maker", snippet: quote }], []);
  assert.equal(rejected.websiteFacts.length, 0); assert.ok(rejected.unknowns.length);
});

test("B: missing independent search Key makes zero external calls; plans and manual website remain usable", async () => {
  const db = database(); let calls = 0;
  try { await withPlatformContext(ctx(db), async () => {
    globalThis.fetch = async () => { calls++; return html(); };
    const state = await act("create_company", { name: "Synthetic Brakes" }), id = state.companies[0].id;
    assert.equal((await readPlatform()).capabilities.searchConfigured, false);
    await assert.rejects(search(id), e => e.code === "SEARCH_NOT_CONFIGURED");
    const plan = await planCompanyWebsite({ companyId: id });
    await assert.rejects(searchCompanyWebsite({ companyId: id, criteria: plan.criteria, planHash: plan.planHash, confirmed: true }), e => e.code === "SEARCH_NOT_CONFIGURED");
    await assert.rejects(searchPublicCandidates("public product query"), e => e.code === "SEARCH_NOT_CONFIGURED");
    assert.equal(calls, 0); assert.equal((await readPlatform()).discoveryRuns.length, 0);
    const manual = await inspectCompanyWebsiteUrl({ companyId: id, criteria: plan.criteria, expectedRevision: 1, url: "https://synthetic.example", confirmed: true });
    assert.equal(manual.result.run.sourceKind, "manual_url"); assert.ok(calls > 0);
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("B: cache is isolated by owner, market and category, with no automatic qualification", async () => {
  const db = database(); let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return Response.json({ results: [{ title: "Synthetic Brakes", url: "https://synthetic.example", content: source }] }); };
    for (const owner of ["u:acceptance-a", "u:acceptance-b"]) await withPlatformContext(ctx(db, owner), async () => {
      await saveSearchKey("tvly-test-SYNTHETIC-INDEPENDENT-KEY");
      const state = await act("create_company", { name: "Synthetic reference" }), id = state.companies[0].id;
      const before = calls, found = await search(id);
      assert.equal(calls, before + 2); assert.equal(found.result.cached, false);
      assert.equal(found.result.run.candidates[0].status, "unverified"); assert.equal(found.state.companies.length, 1);
      assert.equal((await search(id)).result.cached, true); assert.equal(calls, before + 2);
      assert.equal((await search(id, { targetMarket: "France" })).result.cached, false);
      assert.equal((await search(id, { category: "brake_shoe" })).result.cached, false);
      assert.equal(calls, before + 6);
    });
  } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("C: proposals do not apply before confirmation; cancel persists and cannot be applied later", async () => {
  const db = database();
  try { await withPlatformContext(ctx(db), async () => {
    let state = await act("create_company", { name: "Synthetic memory" }); const id = state.companies[0].id;
    const before = state.companies[0].nextAction;
    const input = { companyId: id, occurredAt: "2026-11-20T09:00:00Z", sourceText: "Please review our requirement.", patch: { nextAction: "核对需求" } };
    await act("propose_memory", input); state = await readPlatform();
    const proposal = state.companies[0].memoryProposals[0];
    assert.equal(state.companies[0].nextAction, before); assert.equal(proposal.before.nextAction, before); assert.equal(proposal.after.nextAction, "核对需求");
    await act("propose_memory", input); assert.equal((await readPlatform()).companies[0].memoryProposals.length, 1);
    await act("cancel_memory", { companyId: id, proposalId: proposal.id });
    await act("cancel_memory", { companyId: id, proposalId: proposal.id });
    await assert.rejects(act("apply_memory", { companyId: id, proposalId: proposal.id }), e => e.code === "MEMORY_NOT_PENDING");
    state = await readPlatform(); assert.equal(state.companies[0].nextAction, before); assert.equal(state.companies[0].memoryHistory.length, 0); assert.equal(state.companies[0].memoryProposals[0].status, "cancelled");
  }); } finally { db.raw.close(); }
});

test("C: message idempotency, inquiry/customer isolation, old-message rejection and visible conflicts", async () => {
  const db = database();
  try { await withPlatformContext(ctx(db), async () => {
    let state = await act("create_company", { name: "Synthetic memory A" }); const id = state.companies[0].id;
    state = await act("create_company", { name: "Synthetic memory B" }); const other = state.companies[1].id;
    const msg = { companyId: id, text: "Please review 200 pieces as a new inquiry.", occurredAt: "2026-11-21T10:00:00Z", dataClass: "synthetic" };
    await act("add_communication", msg); await act("add_communication", msg);
    state = await readPlatform(); assert.equal(state.companies[0].communications.length, 1); const message = state.companies[0].communications[0];
    const input = { companyId: id, communicationId: message.id, occurredAt: msg.occurredAt, inquiryId: "rfq-a", patch: { nextAction: "确认200片询价" } };
    await assert.rejects(act("propose_memory", { ...input, companyId: other }), e => e.code === "SOURCE_NOT_FOUND");
    await act("propose_memory", input); state = await readPlatform(); const proposal = state.companies[0].memoryProposals[0];
    const general = state.companies[0].nextAction;
    await act("apply_memory", { companyId: id, proposalId: proposal.id }); await act("apply_memory", { companyId: id, proposalId: proposal.id });
    state = await readPlatform(); assert.equal(state.companies[0].memoryHistory.length, 1); assert.equal(state.companies[0].memoryByInquiry['rfq-a'].values.nextAction, "确认200片询价"); assert.equal(state.companies[0].nextAction, general); assert.equal(state.companies[0].memoryByInquiry['rfq-b'], undefined);
    await act("propose_memory", { companyId: id, inquiryId: "rfq-a", occurredAt: "2026-11-20T10:00:00Z", sourceText: "Older instruction.", patch: { nextAction: "旧指令" } });
    state = await readPlatform(); await assert.rejects(act("apply_memory", { companyId: id, proposalId: state.companies[0].memoryProposals.at(-1).id }), e => e.code === "STALE_MEMORY");
    await act("propose_memory", { companyId: id, occurredAt: msg.occurredAt, sourceText: "Change action", patch: { nextAction: "提议动作" } });
    state = await readPlatform(); const pending = state.companies[0].memoryProposals.at(-1);
    await act("propose_memory", { companyId: id, occurredAt: msg.occurredAt, sourceText: "Competing change", patch: { nextAction: "另一个动作" } });
    state = await readPlatform(); await act("apply_memory", { companyId: id, proposalId: state.companies[0].memoryProposals.at(-1).id });
    await assert.rejects(act("apply_memory", { companyId: id, proposalId: pending.id }), e => e.code === "MEMORY_CONFLICT");
  }); } finally { db.raw.close(); }
});

test("D: name/URL dedup, persisted followup and 50→200 inquiry update never imply a sale", async () => {
  const db = database();
  try { await withPlatformContext(ctx(db), async () => {
    let state = await act("create_company", { name: "Synthetic Buyer", website: "https://buyer.example" }); const companyId = state.companies[0].id;
    await assert.rejects(act("create_company", { name: " synthetic  buyer ", website: "https://other.example" }), e => e.code === "DUPLICATE_COMPANY");
    await assert.rejects(act("create_company", { name: "Other name", website: "https://www.buyer.example/contact" }), e => e.code === "DUPLICATE_COMPANY");
    const imported = await importCompanies("name,website\nSynthetic Buyer,\nThird Lead,https://third.example"); assert.equal(imported.summary.duplicates, 1); assert.equal(imported.summary.imported, 1);
    const request = { companyId, inputs: { quantity: "50", unit: "片", partType: "brake_lining" }, sourceText: "Synthetic RFQ for 50 pieces, not an order.", dataClass: "synthetic", owner: "Demo operator", nextFollowUpAt: "2026-11-24T02:00:00Z" };
    await act("save_inquiry", request); state = await readPlatform(); const inquiry = state.inquiries[0];
    await act("save_inquiry", { ...request, id: inquiry.id, expectedRevision: inquiry.revision, inputs: { ...request.inputs, quantity: "200" }, sourceText: "Synthetic demand update: please quote 200 pieces, not an order." });
    state = await readPlatform(); assert.equal(state.inquiries[0].inputs.quantity, "200"); assert.equal(state.inquiries[0].history.length, 2); assert.equal(state.companies[0].stage, "需求确认"); assert.equal(state.tasks.length, 1); assert.equal(state.tasks[0].owner, "Demo operator");
    assert.ok(state.events.some(e => e.title === "更新询价条件并重新核对"));
    assert.equal((await withPlatformContext(ctx(db, "u:other"), readPlatform)).companies.length, 0);
  }); } finally { db.raw.close(); }
});

test("A–D: search → inspect → confirm save → followup → memory → research uses real handlers with mocked network", async () => {
  const db = database();
  try { await withPlatformContext(ctx(db), async () => {
    await saveSearchKey("tvly-test-SYNTHETIC-END-TO-END-KEY");
    const seed = await importCompanies("name,website\nSynthetic reference,https://reference.example"); const seedId = seed.state.companies[0].id;
    globalThis.fetch = async () => Response.json({ results: [{ title: "Synthetic Brakes", url: "https://synthetic.example", content: source }] });
    const run = (await search(seedId)).result.run;
    globalThis.fetch = async () => html();
    const inspected = (await inspectBuyerCandidate({ runId: run.id, candidateId: run.candidates[0].id })).result.candidate;
    const save = { runId: run.id, candidateId: inspected.id, expectedCandidateHash: inspected.candidateHash, companyName: "Synthetic Brakes", confirmIdentity: true };
    const saved = await saveBuyerCandidate(save), companyId = saved.result.companyId;
    assert.equal((await saveBuyerCandidate(save)).result.duplicate, true);
    let company = (await readPlatform()).companies.find(c => c.id === companyId);
    await act("update_company", { id: companyId, expectedRevision: company.revision, owner: "Demo operator", nextAction: "确认具体需求", nextFollowUpAt: "2026-11-24T02:00:00Z" });
    await act("add_task", { companyId, title: "核对采购负责人", owner: "Demo operator", dueAt: "2026-11-24T02:00:00Z" });
    await act("add_communication", { companyId, text: "Please ask about lead time.", occurredAt: "2026-11-22T02:00:00Z", dataClass: "synthetic" });
    company = (await readPlatform()).companies.find(c => c.id === companyId);
    await act("propose_memory", { companyId, communicationId: company.communications[0].id, occurredAt: company.communications[0].occurredAt, inquiryId: "rfq-new", patch: { nextAction: "核对交期" } });
    company = (await readPlatform()).companies.find(c => c.id === companyId);
    await act("apply_memory", { companyId, proposalId: company.memoryProposals[0].id });
    await assert.rejects(researchCompany(companyId), e => e.code === "MODEL_NOT_CONFIGURED");
    company = (await readPlatform()).companies.find(c => c.id === companyId); assert.equal(company.researchStatus, "evidence_only"); assert.ok(company.evidence.length);
    await saveModelKey("synthetic-b1x-key-not-real");
    let modelCalls = 0;
    globalThis.fetch = async (url, options) => {
      if (!String(url).includes("token.b1x.work")) return html();
      modelCalls++; assert.equal(String(url), "https://token.b1x.work/v1/chat/completions");
      const body = JSON.parse(options.body); assert.equal(body.model, "deepseek-v4.1-flash-1017");
      const supplied = JSON.parse(body.messages[1].content).sources[0];
      return Response.json({ id: "synthetic-completion", model: body.model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output([{ field: "products", value: "官网经营商用车制动衬片", sourceId: supplied.id, quote: source }])) } }] });
    };
    const researched = await researchCompany(companyId); company = researched.state.companies.find(c => c.id === companyId);
    assert.equal(modelCalls, 1); assert.equal(company.researchStatus, "complete"); assert.equal(company.websiteFacts[0].classification, "model_summary_pending_review");
    assert.equal(company.owner, "Demo operator"); assert.equal(company.memoryHistory.length, 1);
    assert.equal((await researchCompany(companyId)).meta.cached, true); assert.equal(modelCalls, 1);
    const persisted = await readRaw(); assert.equal(persisted.state.companies.find(c => c.id === companyId).nextAction, "确认具体需求");
  }); } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});
