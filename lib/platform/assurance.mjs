import { createHash } from "node:crypto";
import { analyzeInquiry, specificationFingerprint } from "./fitment.mjs";

export const COMMITMENT_KINDS = ["reply_update", "dispatch", "price_reference"];
function fail(code, message, status = 400) { throw Object.assign(new Error(message), { code, status, publicError: true }); }
function same(a, b) { return String(a || "").trim().normalize("NFKC").toUpperCase() === String(b || "").trim().normalize("NFKC").toUpperCase(); }
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function timestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const input = value.trim();
  const zoned = /^\d{4}-\d{2}-\d{2}$/.test(input) ? input + "T23:59:59.999+08:00" : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(input) ? input + "+08:00" : input;
  const n = Date.parse(zoned); return Number.isFinite(n) ? n : null;
}
const evidenceFor = (row, type) => ({ id: row.id, type, title: row.sourceTitle || "人工核准依据", quote: row.sourceText || "", url: row.sourceUrl || "", observedAt: row.observedAt || row.confirmedAt || row.createdAt || "" });

/** Current, read-only check. It does not reserve stock, send a message, or approve a price. */
export function assessCommitment(state, request = {}, { now = new Date().toISOString() } = {}) {
  const { companyId, inquiryId, kind } = request;
  if (!COMMITMENT_KINDS.includes(kind)) fail("INVALID_COMMITMENT_KIND", "请选择答复更新、发货或历史参考价。");
  if (!state.companies.some(c => c.id === companyId)) fail("NOT_FOUND", "当前工作区没有该客户。", 404);
  const inquiry = state.inquiries.find(i => i.id === inquiryId && i.companyId === companyId);
  if (!inquiry) fail("NOT_FOUND", "请先保存当前客户的询价记录。", 404);
  if (request.expectedRevision !== undefined && request.expectedRevision !== inquiry.revision) fail("REVISION_CONFLICT", "询价已更新，请刷新后重新核验承诺草案。", 409);
  const nowTime = timestamp(now), dueTime = timestamp(request.dueAt), owner = typeof request.owner === "string" ? request.owner.trim().slice(0, 100) : "";
  const candidateId = typeof request.candidateId === "string" ? request.candidateId.slice(0, 100) : "";
  const blockers = [], evidence = [];
  if (!owner) blockers.push("请指定负责核对与履约的人员。");
  if (request.dueAt && dueTime === null) blockers.push("计划时间格式无效，请重新填写。");
  if ((kind === "reply_update" || kind === "dispatch") && dueTime === null) blockers.push("请填写明确的未来答复/发货时间。");
  if (dueTime !== null && dueTime <= nowTime) blockers.push("计划时间已经过去，请重新安排。");
  const analysis = analyzeInquiry(inquiry.inputs, { catalog: state.fitmentCatalog, relations: state.fitmentRelations, quoteHistory: state.quoteHistory, companyId, inquiryId, dataClass: inquiry.dataClass, now });
  const specHash = specificationFingerprint(inquiry.inputs), candidate = analysis.candidates.find(c => c.id === candidateId);
  if (kind === "dispatch") {
    if (!candidateId) blockers.push("请指定本次准备发货的产品候选。");
    if (!candidate || candidate.status !== "confirmed") blockers.push("当前规格尚无本询价的人工配型核准，不能形成发货承诺草案。");
    const confirmation = (state.fitmentRelations || []).find(r => r.companyId === companyId && r.inquiryId === inquiryId && r.candidateId === candidateId && r.specificationFingerprint === specHash && r.status === "confirmed" && r.dataClass === inquiry.dataClass);
    if (confirmation) evidence.push(evidenceFor(confirmation, "fitment_confirmation"));
    const quantity = /^\d+(\.\d+)?$/.test(inquiry.inputs.quantity || "") ? Number(inquiry.inputs.quantity) : 0;
    if (!(quantity > 0)) blockers.push("采购数量需要明确且大于零。");
    if (!inquiry.inputs.unit) blockers.push("采购数量单位未确认。");
    if (!inquiry.inputs.materialGrade) blockers.push("材质/配方尚未明确，不能据此检查供货。");
    const supply = (state.supplyReferences || []).filter(r => r.companyId === companyId && r.inquiryId === inquiryId && r.candidateId === candidateId && r.specificationFingerprint === specHash && r.dataClass === inquiry.dataClass && r.authorized === true && candidate && r.partNumber === candidate.partNumber && r.namespace === candidate.namespace && same(r.materialGrade, inquiry.inputs.materialGrade)).reverse().sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    if (!supply) blockers.push("缺少与当前件号、规格、材质一致且有来源的供货快照；无法推断库存或交期。");
    else {
      evidence.push(evidenceFor(supply, "supply_snapshot"));
      if (timestamp(supply.observedAt) === null || timestamp(supply.observedAt) > nowTime) blockers.push("供货快照的观察时间无效或位于未来。");
      if (timestamp(supply.validUntil) === null || timestamp(supply.validUntil) < nowTime) blockers.push("供货快照已过期，需要重新确认可供数量。");
      if (dueTime !== null && timestamp(supply.validUntil) < dueTime) blockers.push("供货快照有效期未覆盖拟发货时间，需要企业重新确认并预留。");
      if (!same(supply.unit, inquiry.inputs.unit)) blockers.push("库存数量单位与询价不一致，不能自动换算片/套等单位。");
      if (!Number.isFinite(supply.quantityAvailable) || supply.quantityAvailable < quantity) blockers.push("供货快照数量不足，不能承诺本次全量发货。");
      if (timestamp(supply.earliestDispatchAt) === null) blockers.push("供货依据未给出可核验的最早发货时间。");
      else if (dueTime !== null && dueTime < timestamp(supply.earliestDispatchAt)) blockers.push("拟发货时间早于供货依据中的最早可发时间。");
    }
  } else if (kind === "price_reference") {
    const ranges = analysis.quoteRanges.filter(q => !candidateId || q.candidateId === candidateId);
    if (!ranges.length) blockers.push("当前规格与商业条件没有仍然有效的历史参考价；不能推断折扣、成本或替代报价。");
    for (const range of ranges) {
      if (dueTime !== null && timestamp(range.validUntil) < dueTime) blockers.push("历史价格有效期不覆盖计划使用时间。");
      for (const id of range.referenceIds) { const ref = state.quoteHistory.find(q => q.id === id); if (ref) evidence.push(evidenceFor(ref, "quote_reference")); }
    }
  }
  const normalizedDueAt = dueTime === null ? "" : new Date(dueTime).toISOString();
  const sourceFingerprint = hash({ sourceText: inquiry.sourceText, sourceUrl: inquiry.sourceUrl, dataClass: inquiry.dataClass, inputFingerprint: analysis.inputFingerprint, evidence, kind, candidateId, dueAt: normalizedDueAt, owner });
  return { status: blockers.length ? "blocked" : "ready_for_review", blockers: [...new Set(blockers)], evidence, inputFingerprint: analysis.inputFingerprint, sourceFingerprint,
    companyId, inquiryId, inquiryRevision: inquiry.revision, kind, candidateId, dueAt: normalizedDueAt, owner, checkedAt: new Date(nowTime).toISOString(), dataClass: inquiry.dataClass,
    notice: kind === "dispatch" ? "仅核验发货承诺草案。库存是来源快照，企业仍需确认并安排预留；本平台没有锁定库存、安排发货或发送消息。" : kind === "price_reference" ? "仅供销售复核的历史参考价，不是正式报价或优惠批准；没有发送给客户。" : "答复更新时间由负责人确认能够做到；这是回复准备安排，没有发送消息。",
    sent: false, stockReserved: false };
}
export function currentCommitmentRecords(state) {
  return (state.commitmentRecords || []).map(record => {
    try {
      const currentAssessment = assessCommitment(state, { companyId: record.companyId, inquiryId: record.inquiryId, kind: record.kind, candidateId: record.candidateId, dueAt: record.dueAt, owner: record.owner });
      return { ...record, currentAssessment, needsRecheck: record.inputFingerprint !== currentAssessment.inputFingerprint || record.sourceFingerprint !== currentAssessment.sourceFingerprint || record.assessment.status !== currentAssessment.status };
    } catch (error) { return { ...record, needsRecheck: true, currentAssessment: { status: "blocked", blockers: ["原询价或证据不再可用，请重新核验。"], evidence: [] } }; }
  });
}
