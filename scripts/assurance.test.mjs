import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { detectCustomerSignals } from "../lib/platform/customer-signals.mjs";
import { assessCommitment, currentCommitmentRecords } from "../lib/platform/assurance.mjs";
import { defaultFitmentCatalog, specificationFingerprint } from "../lib/platform/fitment.mjs";
import { withPlatformContext } from "../lib/platform/context.mjs";
import { act } from "../lib/platform/domain.mjs";
import { actInquiry, checkInquiryAssurance } from "../lib/platform/inquiries.mjs";
import { readRaw, readPlatform } from "../lib/platform/store.mjs";

const now = "2026-11-21T10:00:00Z";
const inputs = { partCode: "19032", codeNamespace: "WVA", partType: "brake_lining", materialGrade: "TEST-MATERIAL", quantity: "100", unit: "片", currency: "USD", incoterm: "FOB", destination: "TEST-PORT", accessories: "无附件" };
const request = { companyId: "company", inquiryId: "inquiry", kind: "dispatch", candidateId: "kooying-gys-007", dueAt: "2026-11-23T10:00:00Z", owner: "Test owner" };
function fixture() {
  const spec = specificationFingerprint(inputs);
  return { companies: [{ id: "company" }], fitmentCatalog: defaultFitmentCatalog(), quoteHistory: [], commitmentRecords: [],
    inquiries: [{ id: "inquiry", companyId: "company", revision: 1, inputs, sourceText: "Synthetic request", sourceUrl: "", dataClass: "synthetic" }],
    fitmentRelations: [{ id: "fitment-1", companyId: "company", inquiryId: "inquiry", candidateId: "kooying-gys-007", specificationFingerprint: spec, status: "confirmed", dataClass: "synthetic", sourceTitle: "Test confirmation", sourceText: "Test only.", confirmedBy: "Test engineer", confirmedAt: now }],
    supplyReferences: [{ id: "stock-1", companyId: "company", inquiryId: "inquiry", candidateId: "kooying-gys-007", partNumber: "GYS-007", namespace: "INTERNAL", specificationFingerprint: spec, materialGrade: "TEST-MATERIAL", authorized: true, dataClass: "synthetic", quantityAvailable: 100, unit: "片", observedAt: "2026-11-21T09:00:00Z", validUntil: "2026-11-24T10:00:00Z", earliestDispatchAt: "2026-11-22T10:00:00Z", sourceTitle: "Synthetic stock snapshot", sourceText: "Test only, not real inventory." }] };
}
test("原文标签仅明确陈述，否定/条件/弯引号不会冒认急迫；议价不推财务状况", () => {
  for (const sentence of ["This is not urgent.", "No rush.", "This isn’t urgent.", "We don’t need it today.", "不着急。", "如果客户急需，请通知我。", "Maybe urgent."]) {
    assert.equal(detectCustomerSignals(sentence).some(x => x.kind === "urgent"), false, sentence);
  }
  const raw = "We need it urgently. The price is too high. We are worried about delivery. We are still deciding.";
  const signals = detectCustomerSignals(raw);
  assert.deepEqual(signals.map(x => x.kind), ["urgent", "price", "delivery", "decision"]);
  assert.ok(signals.every(x => raw.includes(x.quote) && x.status === "pending_review" && x.method === "rule"));
  assert.equal(signals.some(x => /无能力|偿债|财务/.test(x.label)), false);
  assert.equal(detectCustomerSignals("Buyer in UK.").length, 0);
  assert.deepEqual(detectCustomerSignals("This order is urgent and the price seems expensive. Could you confirm dispatch timing?").map(x => [x.kind, x.label]), [["urgent", "急需处理"], ["price", "关注价格"], ["delivery", "关注交期"]]);
});
test("发货核验需完整证据；过期/单位/数量/可发时间/改规格均阻止", () => {
  const state = fixture();
  const ready = assessCommitment(state, request, { now });
  assert.equal(ready.status, "ready_for_review"); assert.equal(ready.sent, false); assert.equal(ready.stockReserved, false);
  assert.equal(ready.evidence.length, 2);
  for (const patch of [{ validUntil: "2026-11-20T00:00:00Z" }, { unit: "套" }, { quantityAvailable: 99 }, { earliestDispatchAt: "2026-11-24T00:00:00Z" }, { authorized: false }, { dataClass: "real" }]) {
    const changed = fixture(); Object.assign(changed.supplyReferences[0], patch);
    assert.equal(assessCommitment(changed, request, { now }).status, "blocked", JSON.stringify(patch));
  }
  const noSupply = fixture(); noSupply.supplyReferences = []; assert.equal(assessCommitment(noSupply, request, { now }).status, "blocked");
  const changedSpecs = fixture(); changedSpecs.inquiries[0].inputs = { ...inputs, rawWidth: "180" };
  assert.equal(assessCommitment(changedSpecs, request, { now }).status, "blocked");
  const latest = fixture(); latest.supplyReferences.push({ ...latest.supplyReferences[0], id: "stock-2", observedAt: "2026-11-21T09:30:00Z", quantityAvailable: 0 });
  assert.equal(assessCommitment(latest, request, { now }).status, "blocked");
  latest.supplyReferences[1].observedAt = latest.supplyReferences[0].observedAt;
  assert.equal(assessCommitment(latest, request, { now }).status, "blocked", "同观察时刻的后录入快照优先，不能挑旧高库存");
});
test("答复更新只需负责人和未来时间，历史价会实时重算有效性", () => {
  const state = fixture(); state.supplyReferences = []; state.fitmentRelations = [];
  assert.equal(assessCommitment(state, { ...request, kind: "reply_update", candidateId: "" }, { now }).status, "ready_for_review");
  assert.equal(assessCommitment(state, { ...request, kind: "reply_update", owner: "" }, { now }).status, "blocked");
  assert.equal(assessCommitment(state, { ...request, kind: "price_reference" }, { now }).status, "blocked");
  state.quoteHistory.push({ id: "quote-1", companyId: "company", dataClass: "synthetic", authorized: true, partNumber: "GYS-007", namespace: "INTERNAL", ...inputs, quantityMin: 1, quantityMax: 200, unitPrice: 4.5, specificationFingerprint: specificationFingerprint(inputs), validFrom: "2026-11-20T00:00:00Z", validUntil: "2026-11-25T00:00:00Z", sourceTitle: "Synthetic quote", sourceText: "Test only." });
  assert.equal(assessCommitment(state, { ...request, kind: "price_reference", dueAt: "" }, { now }).status, "ready_for_review");
  assert.equal(assessCommitment(state, { ...request, kind: "price_reference", dueAt: "" }, { now: "2026-11-26T00:00:00Z" }).status, "blocked");
});
async function database() {
  const sql = new DatabaseSync(":memory:");
  for (const file of (await readdir(new URL("../drizzle/", import.meta.url))).filter(f => f.endsWith(".sql")).sort()) sql.exec(await readFile(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  return { raw: sql, prepare(query) { return { bind(...values) { return { async first() { return sql.prepare(query).get(...values) || null; }, async run() { return { meta: { changes: Number(sql.prepare(query).run(...values).changes) } }; } }; } }; } };
}
test("承诺草案记录责任人/原文/时间/指纹；只读不写库；更改询价需重核", async () => {
  const db = await database();
  try {
    await withPlatformContext({ db, ownerId: "u:assurance-test", authenticated: true, dataKey: "" }, async () => {
      let state = await act("create_company", { name: "Synthetic assurance customer" }), companyId = state.companies[0].id;
      const payload = { companyId, inputs, sourceText: "We need it urgently.", dataClass: "synthetic", owner: "Test owner" };
      state = await actInquiry("save_inquiry", payload); let inquiry = state.inquiries[0];
      const ask = { companyId, inquiryId: inquiry.id, kind: "dispatch", candidateId: "kooying-gys-007", dueAt: new Date(Date.now() + 86400000).toISOString(), owner: "Test owner", expectedRevision: inquiry.revision };
      const before = JSON.stringify(await readRaw());
      const checked = await checkInquiryAssurance(ask); assert.equal(checked.status, "blocked"); assert.equal(JSON.stringify(await readRaw()), before);
      state = await actInquiry("save_commitment", { ...ask, reviewed: true });
      const record = state.commitmentRecords[0]; assert.equal(record.owner, "Test owner"); assert.equal(record.sourceText, payload.sourceText); assert.ok(record.sourceFingerprint); assert.ok(record.createdAt); assert.equal(record.sent, false); assert.equal(record.status, "draft_saved");
      assert.equal(record.assessment.status, "blocked"); assert.equal(record.needsRecheck, false);
      inquiry = state.inquiries[0];
      await assert.rejects(() => actInquiry("save_commitment", { ...ask, reviewed: true }), e => e.code === "REVISION_CONFLICT");
      state = await actInquiry("save_inquiry", { ...payload, id: inquiry.id, expectedRevision: inquiry.revision, inputs: { ...inputs, quantity: "200" } });
      assert.equal(state.commitmentRecords[0].needsRecheck, true); assert.ok(state.events.some(e => e.type === "commitment_draft_saved"));
      inquiry = state.inquiries[0];
      state = await actInquiry("add_supply_reference", { companyId, inquiryId: inquiry.id, candidateId: "kooying-gys-007", expectedRevision: inquiry.revision, quantityAvailable: 200, unit: "片", observedAt: new Date(Date.now() - 60000).toISOString(), validUntil: new Date(Date.now() + 2 * 86400000).toISOString(), earliestDispatchAt: new Date(Date.now() + 86400000).toISOString(), sourceTitle: "Synthetic stock fixture", sourceText: "Test-only source.", authorized: true, dataClass: "synthetic" });
      assert.equal(state.supplyReferences[0].partNumber, "GYS-007"); assert.equal(state.supplyReferences[0].materialGrade, inputs.materialGrade);
      assert.equal(state.supplyReferences[0].quantityAvailable, 200); assert.equal(state.inquiries[0].revision, inquiry.revision + 1);
    });
    assert.equal((await withPlatformContext({ db, ownerId: "u:another", authenticated: true, dataKey: "" }, readPlatform)).commitmentRecords.length, 0);
  } finally { db.raw.close(); }
});
