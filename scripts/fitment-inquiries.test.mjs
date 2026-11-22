import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { analyzeInquiry, defaultFitmentCatalog, normalizeInputs, specificationFingerprint } from "../lib/platform/fitment.mjs";
import { withPlatformContext } from "../lib/platform/context.mjs";
import { readPlatform, readRaw } from "../lib/platform/store.mjs";
import { act } from "../lib/platform/domain.mjs";
import { actInquiry, matchCurrentInquiry } from "../lib/platform/inquiries.mjs";

async function database() {
  const sql = new DatabaseSync(":memory:");
  for (const file of (await readdir(new URL("../drizzle/", import.meta.url))).filter(f => f.endsWith(".sql")).sort()) sql.exec(await readFile(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  return { raw: sql, prepare(query) { return { bind(...values) { return {
    async first() { return sql.prepare(query).get(...values) || null; },
    async run() { const result = sql.prepare(query).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
  }; } }; } };
}
function context(db, ownerId = "u:inquiry-owner") { return { db, ownerId, authenticated: true, dataKey: "", displayName: "Synthetic test" }; }
const query = { partCode: "19032", codeNamespace: "WVA", partType: "brake_lining", materialGrade: "TEST-MATERIAL", quantity: "120", currency: "USD", unit: "片", incoterm: "FOB", destination: "TEST-PORT", accessories: "无附件" };
const savePayload = companyId => ({ companyId, inputs: query, sourceText: "Synthetic test RFQ, not a real buyer request.", channel: "MIC", dataClass: "synthetic" });
function quotePayload(companyId, inquiryId) {
  return { companyId, inquiryId, inputs: query, partNumber: "GYS-007", namespace: "INTERNAL", materialGrade: query.materialGrade, currency: "USD", unit: "片", incoterm: "FOB", destination: query.destination, accessories: "无附件", quantityMin: 100, quantityMax: 200, unitPrice: 4.5, validFrom: "2000-01-01", validUntil: "2099-12-31", sourceTitle: "Synthetic quote fixture", sourceText: "Synthetic authorized price fixture, not commercial data.", authorized: true, dataClass: "synthetic" };
}

test("车型不能猜配件；品牌仅相关，目录原值筛到一条仍不证明适配", () => {
  assert.equal(analyzeInquiry({ vehicleModel: "UNVERIFIED TRUCK" }).totalCandidates, 0);
  const brand = analyzeInquiry({ axleBrand: "BPW", partType: "brake_lining" });
  assert.equal(brand.totalCandidates, 3); assert.ok(brand.candidates.every(c => c.status === "candidate" && c.kind === "company"));
  const width = analyzeInquiry({ axleBrand: "BPW", partType: "brake_lining", rawWidth: "180" });
  assert.equal(width.totalCandidates, 1); assert.equal(width.candidates[0].partNumber, "GYS-007"); assert.equal(width.status, "candidates");
  assert.ok(width.missing.some(m => m.includes("车桥")));
  const unconfirmedUnits = analyzeInquiry({ axleBrand: "BPW", widthMm: "180" });
  assert.equal(unconfirmedUnits.totalCandidates, 3); assert.ok(unconfirmedUnits.missing.some(m => m.includes("单位")));
});

test("后来加入的年份、片型、厚度冲突排除；错号不回退；代号不换算 mm", () => {
  const oem = { axleModel: "MVB FST10010", brakeSystem: "SN4218", year: "2024", partType: "brake_lining", thicknessMm: "18" };
  const result = analyzeInquiry(oem);
  assert.equal(result.totalCandidates, 1); assert.equal(result.candidates[0].partNumber, "09.801.07.41.0"); assert.equal(result.candidates[0].kind, "oem");
  for (const change of [{ year: "2022" }, { thicknessMm: "21" }, { partType: "disc_brake_pad" }, { axleModel: "WRONG AXLE" }]) {
    const changed = analyzeInquiry({ ...oem, ...change }); assert.equal(changed.totalCandidates, 0); assert.ok(changed.excluded.length);
  }
  assert.equal(analyzeInquiry({ axleBrand: "BPW", partCode: "1903X", codeNamespace: "WVA" }).totalCandidates, 0);
  assert.equal(analyzeInquiry({ partCode: "BC/36/1", codeNamespace: "OE" }).totalCandidates, 0);
  for (const sizeCode of ["STD", "1+", "2+"]) {
    const result = analyzeInquiry({ ...query, sizeCode }); assert.equal(result.inputs.sizeCode, sizeCode); assert.equal(result.inputs.thicknessMm, ""); assert.ok(result.missing.some(m => m.includes(sizeCode)));
  }
  assert.equal(normalizeInputs({ thicknessMm: "1+" }).thicknessMm, "1+");
});

test("只读纯规则无模型调用，最多显示三条且保留真实总数", () => {
  const catalog = defaultFitmentCatalog().filter(c => c.kind === "company" && c.axleBrand === "BPW");
  catalog.push({ ...structuredClone(catalog[0]), id: "synthetic-extra", partNumber: "SYNTHETIC-EXTRA", note: "test fixture" });
  const oldFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error("No network allowed in pure match"); };
  try {
    const result = analyzeInquiry({ axleBrand: "BPW" }, { catalog }); assert.equal(result.totalCandidates, 4); assert.equal(result.candidates.length, 3);
    assert.ok(result.elapsedMs >= 0); assert.ok(result.engineVersion); assert.ok(result.trace.length);
  } finally { globalThis.fetch = oldFetch; }
});

test("具体车桥查询将无映射品牌行移到旁证，追问真正区分候选的厚度", () => {
  const specific = { axleBrand: "BPW", axleModel: "MVB FST10010", brakeSystem: "SN4218", partType: "brake_lining", year: "2024" };
  const before = analyzeInquiry(specific);
  assert.equal(before.totalCandidates, 3); assert.equal(before.relatedCatalogue.length, 3);
  assert.ok(before.questions[0].includes("18 / 19 / 20 mm"));
  const after = analyzeInquiry({ ...specific, thicknessMm: "19" });
  assert.equal(after.totalCandidates, 1); assert.equal(after.candidates[0].partNumber, "09.801.07.42.0");
  assert.equal(after.relatedCatalogue.length, 3); assert.ok(after.candidates.every(c => c.kind === "oem"));
  const unknown = analyzeInquiry({ ...specific, axleModel: "UNVERIFIED AXLE", brakeSystem: "UNVERIFIED BRAKE" });
  assert.equal(unknown.totalCandidates, 0); assert.equal(unknown.relatedCatalogue.length, 3); assert.ok(unknown.missing[0].includes("尚未建立"));
  assert.throws(() => normalizeInputs({ photoUrl: "javascript:alert(1)" }), e => e.code === "INVALID_PHOTO_URL");
});

test("历史价逐项匹配、过期拒绝；规格变化及客户隔离使旧价失效", () => {
  const q = { ...quotePayload("customer-a", "inquiry-a"), id: "q1", specificationFingerprint: specificationFingerprint(query) };
  const options = { companyId: "customer-a", dataClass: "synthetic", quoteHistory: [q], now: "2026-11-21T00:00:00Z" };
  assert.equal(analyzeInquiry(query, options).quoteRanges[0].min, 4.5);
  for (const patch of [{ currency: "CNY" }, { unit: "套" }, { incoterm: "CIF" }, { materialGrade: "OTHER" }, { destination: "OTHER" }, { accessories: "含铆钉" }, { quantity: "201" }, { rawWidth: "180" }]) {
    assert.equal(analyzeInquiry({ ...query, ...patch }, options).quoteRanges.length, 0, JSON.stringify(patch));
  }
  assert.equal(analyzeInquiry(query, { ...options, now: "2100-01-01" }).quoteRanges.length, 0);
  assert.equal(analyzeInquiry(query, { ...options, companyId: "customer-b" }).quoteRanges.length, 0);
  assert.equal(analyzeInquiry(query, { ...options, dataClass: "real" }).quoteRanges.length, 0);
  assert.equal(analyzeInquiry(query, { ...options, companyId: undefined }).quoteRanges.length, 0);
  assert.equal(analyzeInquiry({ ...query, partCode: "19094" }, options).quoteRanges.length, 0);
});

test("保存版本校验、跟进不重复、只读不写库、客户和工作区隔离", async () => {
  const db = await database();
  try {
    await withPlatformContext(context(db), async () => {
      let state = await act("create_company", { name: "Synthetic inquiry customer A" });
      const companyId = state.companies[0].id;
      state = await act("save_inquiry", savePayload(companyId));
      const inquiry = state.inquiries[0]; assert.equal(inquiry.revision, 1); assert.equal(state.tasks.length, 1); assert.equal(state.companies[0].stage, "需求确认");
      const rawBefore = JSON.stringify(await readRaw());
      await matchCurrentInquiry(query, { companyId, dataClass: "synthetic" });
      assert.equal(JSON.stringify(await readRaw()), rawBefore);
      state = await actInquiry("save_inquiry", { ...savePayload(companyId), id: inquiry.id, expectedRevision: 1, inputs: { ...query, rawWidth: "180" } });
      assert.equal(state.tasks.length, 1); assert.equal(state.inquiries[0].history.length, 2); assert.equal(state.inquiries[0].revision, 2);
      await assert.rejects(() => actInquiry("save_inquiry", { ...savePayload(companyId), id: inquiry.id, expectedRevision: 1 }), e => e.code === "REVISION_CONFLICT");
      state = await act("create_company", { name: "Synthetic inquiry customer B" });
      const second = state.companies.find(c => c.id !== companyId);
      await assert.rejects(() => actInquiry("save_inquiry", { ...savePayload(second.id), id: inquiry.id, expectedRevision: 2 }), e => e.code === "NOT_FOUND");
      await assert.rejects(() => matchCurrentInquiry(query, { companyId: "not-in-workspace" }), e => e.code === "NOT_FOUND");
    });
    const other = await withPlatformContext(context(db, "u:second-owner"), readPlatform);
    assert.equal(other.inquiries.length, 0); assert.equal(other.quoteHistory.length, 0); assert.equal(other.fitmentRelations.length, 0);
  } finally { db.raw.close(); }
});

test("来源价保存可用，配置变化撤回；人工核准限定配置且不跨客户", async () => {
  const db = await database();
  try {
    await withPlatformContext(context(db), async () => {
      let state = await act("create_company", { name: "Synthetic price customer" }), companyId = state.companies[0].id;
      state = await actInquiry("save_inquiry", savePayload(companyId)); let inquiry = state.inquiries[0];
      await assert.rejects(() => actInquiry("add_quote_reference", { ...quotePayload(companyId, inquiry.id), sourceText: "" }), e => e.code === "INVALID_FIELDS");
      state = await actInquiry("add_quote_reference", quotePayload(companyId, inquiry.id));
      inquiry = state.inquiries[0]; assert.equal(inquiry.analysis.quoteRanges.length, 1);
      state = await actInquiry("confirm_fitment", { companyId, inquiryId: inquiry.id, candidateId: "kooying-gys-007", expectedRevision: inquiry.revision, sourceTitle: "Synthetic engineer fixture", sourceText: "Test-only configuration confirmation.", confirmedBy: "Test engineer", authorized: true });
      inquiry = state.inquiries[0]; assert.equal(inquiry.analysis.status, "confirmed");
      assert.equal(state.companies[0].stage, "需求确认");
      const ownMatch = await matchCurrentInquiry(query, { companyId, inquiryId: inquiry.id, dataClass: "synthetic" });
      assert.equal(ownMatch.status, "confirmed");
      const newDraft = await matchCurrentInquiry(query, { companyId, dataClass: "synthetic" });
      assert.equal(newDraft.status, "candidates");
      const sameCustomerNew = await actInquiry("save_inquiry", savePayload(companyId));
      assert.equal(sameCustomerNew.inquiries.find(i => i.id !== inquiry.id).analysis.status, "candidates");
      const standalone = analyzeInquiry(query, { catalog: state.fitmentCatalog, relations: state.fitmentRelations, companyId: "another-customer", dataClass: "synthetic" });
      assert.equal(standalone.status, "candidates");
      state = await actInquiry("save_inquiry", { ...savePayload(companyId), id: inquiry.id, expectedRevision: inquiry.revision, inputs: { ...query, rawWidth: "180" } });
      inquiry = state.inquiries[0]; assert.equal(inquiry.analysis.status, "candidates"); assert.equal(inquiry.analysis.quoteStatus, "pending"); assert.equal(inquiry.history.at(-1).quoteInvalidated, true);
      assert.equal(state.tasks.filter(t => t.inquiryId === inquiry.id).length, 1);
      await assert.rejects(() => actInquiry("add_quote_reference", { ...quotePayload(companyId, inquiry.id), dataClass: "real" }), e => e.code === "DATA_CLASS_MISMATCH");
    });
  } finally { db.raw.close(); }
});

test("人工核准不删除商业缺项；更早人工提醒保留；报价按上海日期到期", async () => {
  const db = await database();
  try {
    await withPlatformContext(context(db), async () => {
      const early = new Date(Date.now() + 20 * 60 * 1000).toISOString();
      let state = await act("create_company", { name: "Synthetic reminder customer", nextFollowUpAt: early }), companyId = state.companies[0].id;
      const noMaterial = { ...query, materialGrade: "" };
      state = await actInquiry("save_inquiry", { ...savePayload(companyId), inputs: noMaterial, nextFollowUpAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString() });
      let inquiry = state.inquiries[0]; assert.equal(inquiry.nextFollowUpAt, early); assert.equal(state.tasks[0].dueAt, early);
      state = await actInquiry("confirm_fitment", { companyId, inquiryId: inquiry.id, candidateId: "kooying-gys-007", expectedRevision: inquiry.revision, sourceTitle: "Synthetic scope source", sourceText: "Synthetic configuration only, material unknown.", confirmedBy: "Test engineer", authorized: true });
      assert.equal(state.inquiries[0].analysis.status, "confirmed"); assert.ok(state.inquiries[0].analysis.missing.some(m => m.includes("材质")));
      state = await actInquiry("add_quote_reference", { ...quotePayload(companyId, inquiry.id), validFrom: "2026-11-21", validUntil: "2026-11-21" });
      const q = state.quoteHistory[0]; assert.equal(q.validFrom, "2026-11-20T16:00:00.000Z"); assert.equal(q.validUntil, "2026-11-21T15:59:59.999Z");
      assert.equal(analyzeInquiry(query, { companyId, dataClass: "synthetic", quoteHistory: [q], now: "2026-11-21T16:00:00.000Z" }).quoteRanges.length, 0);
    });
  } finally { db.raw.close(); }
});
