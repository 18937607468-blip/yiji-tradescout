import { createHash, randomUUID } from "node:crypto";
import { mutatePlatform, readRaw } from "./store.mjs";
import { analyzeInquiry, normalizeInputs, specificationFingerprint } from "./fitment.mjs";
import { assessCommitment } from "./assurance.mjs";
import { detectCustomerSignals } from "./customer-signals.mjs";
import { calculateMaterialCost, MATERIAL_FORMULA } from "./material-cost.mjs";

export const INQUIRY_ACTIONS = new Set(["save_inquiry", "add_quote_reference", "confirm_fitment", "add_supply_reference", "save_commitment", "save_material_calculation"]);
function error(code, message, status = 400) { throw Object.assign(new Error(message), { code, status, publicError: true }); }
function text(value, name, max = 400, required = false) {
  if (value != null && typeof value !== "string") error("INVALID_FIELDS", name + " 需要文本格式。");
  const result = (value || "").trim();
  if (result.length > max || (required && !result)) error("INVALID_FIELDS", name + " 缺失或长度不符合要求。");
  return result;
}
function url(value) {
  const result = text(value, "来源网址", 2048);
  if (!result) return "";
  try { const parsed = new URL(result); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); return parsed.href; }
  catch { error("INVALID_URL", "来源链接必须是有效 HTTP(S) 网址。"); }
}
function date(value, name, required = false, endOfDay = false) {
  const result = text(value, name, 64, required);
  if (!result) return "";
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(result) ? result + (endOfDay ? "T23:59:59.999+08:00" : "T00:00:00.000+08:00") : result;
  if (!Number.isFinite(Date.parse(raw))) error("INVALID_DATE", name + " 日期格式无效。");
  return new Date(raw).toISOString();
}
function positive(value, name) {
  if (typeof value !== "number" && typeof value !== "string") error("INVALID_NUMBER", name + " 请填写正数。");
  if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value.trim())) error("INVALID_NUMBER", name + " 请填写正数。");
  const n = Number(value); if (!Number.isFinite(n) || n <= 0 || n > 1e12) error("INVALID_NUMBER", name + " 请填写有效正数。"); return n;
}
function dataClass(value) { if (!["real", "synthetic"].includes(value)) error("DATA_CLASS_REQUIRED", "请选择真实询价或演示样例。"); return value; }
function companyFor(state, id) { const company = state.companies.find(c => c.id === id); if (!company) error("NOT_FOUND", "当前工作区没有该客户。", 404); return company; }
function inquiryFor(state, id, companyId) { const inquiry = state.inquiries.find(i => i.id === id && i.companyId === companyId); if (!inquiry) error("NOT_FOUND", "没有找到该客户的询价记录。", 404); return inquiry; }
function revision(record, expected) { if (!Number.isInteger(expected) || expected !== record.revision) error("REVISION_CONFLICT", "询价已被更新，请刷新后重新核对；本次没有覆盖较新记录。", 409); }
const materialHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function materialInquiryBasisHash(inquiry) {
  return materialHash({ companyId: inquiry.companyId, id: inquiry.id, dataClass: inquiry.dataClass, inputs: normalizeInputs(inquiry.inputs), sourceText: inquiry.sourceText || "", sourceUrl: inquiry.sourceUrl || "" });
}
function options(state, inquiry) { return { catalog: state.fitmentCatalog, relations: state.fitmentRelations, quoteHistory: state.quoteHistory, companyId: inquiry.companyId, inquiryId: inquiry.id, dataClass: inquiry.dataClass }; }
function event(state, companyId, type, title, extra = {}) { state.events.push({ id: randomUUID(), companyId, type, title, createdAt: new Date().toISOString(), ...extra }); }
function difference(before, after, now) {
  const beforeIds = before?.analysis?.candidateIds || before?.analysis?.candidates?.map(c => c.id) || [], afterIds = after.analysis.candidateIds || after.analysis.candidates.map(c => c.id);
  return { id: randomUUID(), at: now, beforeFingerprint: before?.analysis?.inputFingerprint || "", afterFingerprint: after.analysis.inputFingerprint,
    beforeCandidates: beforeIds, afterCandidates: afterIds, added: afterIds.filter(id => !beforeIds.includes(id)), removed: beforeIds.filter(id => !afterIds.includes(id)),
    changedFields: Object.keys(after.inputs).filter(k => before?.inputs?.[k] !== after.inputs[k]),
    quoteInvalidated: !!before?.analysis?.quoteRanges?.length && (!after.analysis.quoteRanges.length || specificationFingerprint(before.inputs) !== specificationFingerprint(after.inputs)) };
}
function followup(state, inquiry, company, now) {
  let task = state.tasks.find(t => t.inquiryId === inquiry.id && t.companyId === company.id);
  const title = (inquiry.analysis.status === "confirmed" ? "询价核对/回复准备：核对材质、数量与商业条款" : "询价核对/回复准备：" + (inquiry.analysis.questions[0] || "核对铭牌与原件编号")).slice(0, 400);
  const dates = [inquiry.nextFollowUpAt, company.nextFollowUpAt, ...state.tasks.filter(t => t.companyId === company.id && t.status === "open").map(t => t.dueAt)].filter(d => d && Number.isFinite(Date.parse(d)));
  const dueAt = dates.length ? new Date(Math.min(...dates.map(Date.parse))).toISOString() : new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  inquiry.nextFollowUpAt = dueAt;
  if (!task) { task = { id: randomUUID(), companyId: company.id, inquiryId: inquiry.id, createdAt: now, status: "open" }; state.tasks.push(task); }
  Object.assign(task, { title, dueAt, owner: inquiry.owner || company.owner || "", updatedAt: now, status: "open" });
  if (["待研究", "待联系", "已联系"].includes(company.stage)) company.stage = "需求确认";
  company.nextAction = title; company.nextFollowUpAt = dueAt;
  company.updatedAt = now; company.revision = (company.revision || 0) + 1;
}
/** @param {unknown} inputs
 * @param {{ companyId?: string, inquiryId?: string, dataClass?: string }} [options]
 */
export async function matchCurrentInquiry(inputs, { companyId, inquiryId, dataClass: classValue = "real" } = {}) {
  const { state } = await readRaw();
  if (companyId) companyFor(state, companyId);
  if (inquiryId) inquiryFor(state, inquiryId, companyId);
  return analyzeInquiry(inputs, { catalog: state.fitmentCatalog, relations: state.fitmentRelations, quoteHistory: state.quoteHistory, companyId, inquiryId, dataClass: dataClass(classValue) });
}
/** @param {{companyId:string,inquiryId:string,kind:string,candidateId?:string,dueAt?:string,owner?:string,expectedRevision?:number}} request */
export async function checkInquiryAssurance(request) { return assessCommitment((await readRaw()).state, request); }
export async function actInquiry(type, payload = {}) {
  if (!INQUIRY_ACTIONS.has(type)) error("UNKNOWN_ACTION", "未识别的询价操作。");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) error("INVALID_FIELDS", "询价操作字段格式无效。");
  return mutatePlatform(state => {
    const companyId = text(payload.companyId, "客户", 100, true), company = companyFor(state, companyId), now = new Date().toISOString();
    if (type === "save_material_calculation") {
      const allowed = new Set(["companyId", "inquiryId", "expectedRevision", "clientRequestId", "sourceCandidateId", "inputs"]);
      if (Object.keys(payload).some(key => !allowed.has(key))) error("MATERIAL_INVALID_INPUT", "材料核算仅接收输入条件，不接收客户端金额、数据身份或额外字段。");
      const inquiry = inquiryFor(state, text(payload.inquiryId, "询价编号", 100, true), companyId);
      const clientRequestId = text(payload.clientRequestId, "保存请求编号", 160, true);
      const sourceCandidateId = text(payload.sourceCandidateId, "参考目录行", 160);
      const calculation = calculateMaterialCost(payload.inputs);
      const requestFingerprint = materialHash({ companyId, inquiryId: inquiry.id, sourceCandidateId, inputs: calculation.inputs });
      const history = inquiry.materialCalculations || [];
      const duplicate = history.find(item => item.clientRequestId === clientRequestId);
      if (duplicate) {
        if (duplicate.requestFingerprint !== requestFingerprint) error("MATERIAL_REQUEST_CONFLICT", "该保存请求已经用于另一组核算输入，请重新保存当前条件。", 409);
        return; // A response retry does not duplicate or revive a historical calculation.
      }
      revision(inquiry, payload.expectedRevision);
      let catalogue = null;
      if (sourceCandidateId) {
        const fresh = analyzeInquiry(inquiry.inputs, options(state, inquiry));
        const candidate = [...fresh.candidates, ...(fresh.relatedCatalogue || [])].find(item => item.id === sourceCandidateId && item.kind === "company" && item.partType === "brake_lining");
        if (!candidate) error("MATERIAL_CANDIDATE_CHANGED", "只能采用这条询价当前有效的冠英衬片候选或旁证目录行；请刷新后核对。", 409);
        catalogue = Object.fromEntries(["id", "partNumber", "namespace", "name", "kind", "partType", "dimensions", "dimensionsRaw", "evidence", "note"].map(key => [key, structuredClone(candidate[key] ?? null)]));
      }
      const warnings = [...calculation.warnings];
      if (inquiry.inputs.currency && inquiry.inputs.currency !== calculation.result.currency) warnings.push("客户询价币种为 " + inquiry.inputs.currency + "，本次材料核算为 " + calculation.result.currency + "；未换汇，不能直接作为该币种报价。");
      if (inquiry.inputs.sizeCode) warnings.push("规格代号 " + inquiry.inputs.sizeCode + " 仅保留原文；本核算未将其转换为厚度或修正值。");
      const record = { id: randomUUID(), clientRequestId, requestFingerprint, sourceCandidateId,
        ...calculation, warnings, inquiryBasisHash: materialInquiryBasisHash(inquiry),
        sourceSnapshot: { inquiry: { companyId, id: inquiry.id, dataClass: inquiry.dataClass, inputs: structuredClone(inquiry.inputs), sourceText: inquiry.sourceText, sourceUrl: inquiry.sourceUrl },
          catalogue, formula: MATERIAL_FORMULA, materialPriceSourceText: calculation.inputs.materialPrice.sourceText },
        assumptions: ["按用户提供的外弧、宽度、双厚度平均值公式估算衬片材料；不是最终销售报价。", "本次密度 " + calculation.normalized.densityGPerCm3 + " g/cm³，核算系数 " + calculation.normalized.adjustmentFactor + "，均为可修改的核算假设。",
          ...(catalogue && !catalogue.dimensions?.unit ? ["参考目录未明示尺寸单位，采用原值时按 mm 假设；未自动核准目录单位或配件适配。"] : []),
          ...(catalogue ? ["目录斜杠厚度如被采用，按两端厚度试算；人工填写或修改的尺寸须与原件另行核对。"] : [])],
        dataClass: inquiry.dataClass, createdAt: now, recordedBy: inquiry.owner || company.owner || "", stale: false };
      inquiry.materialCalculations = [...history, record]; inquiry.revision += 1; inquiry.updatedAt = now;
      event(state, companyId, "material_calculation_saved", "保存衬片材料核算参考", { inquiryId: inquiry.id, calculationId: record.id, summary: "服务端重算并保留原值、单位与来源；未生成正式报价、未核准适配、未换汇。" });
      return;
    }
    if (type === "add_supply_reference") {
      const inquiry = inquiryFor(state, text(payload.inquiryId, "询价编号", 100, true), companyId);
      revision(inquiry, payload.expectedRevision);
      if (payload.authorized !== true) error("SOURCE_REQUIRED", "请确认有权使用该供货依据。");
      const classValue = dataClass(payload.dataClass);
      if (classValue !== inquiry.dataClass) error("DATA_CLASS_MISMATCH", "真实询价与演示供货依据不能混用。");
      const candidateId = text(payload.candidateId, "产品候选", 100, true);
      const candidate = analyzeInquiry(inquiry.inputs, options(state, inquiry)).candidates.find(c => c.id === candidateId);
      if (!candidate) error("CANDIDATE_CHANGED", "该产品已不在本次条件候选内，请重新核对。", 409);
      if (!inquiry.inputs.materialGrade) error("MATERIAL_REQUIRED", "请先确认并保存询价材质/配方，才能记录对应的供货快照。");
      const numberText = String(payload.quantityAvailable ?? "");
      if (!/^\d+(\.\d+)?$/.test(numberText) || Number(numberText) > 1e12) error("INVALID_NUMBER", "可供数量应为有效非负数。");
      const record = { id: randomUUID(), companyId, inquiryId: inquiry.id, candidateId, partNumber: candidate.partNumber, namespace: candidate.namespace,
        materialGrade: inquiry.inputs.materialGrade, specificationFingerprint: specificationFingerprint(inquiry.inputs), inputs: structuredClone(inquiry.inputs),
        quantityAvailable: Number(numberText), unit: text(payload.unit, "供货数量单位", 60, true), observedAt: date(payload.observedAt, "供货观察时间", true),
        validUntil: date(payload.validUntil, "供货依据有效期", true, true), earliestDispatchAt: date(payload.earliestDispatchAt, "最早可发货时间", true),
        sourceTitle: text(payload.sourceTitle, "供货来源名称", 200, true), sourceText: text(payload.sourceText, "供货原始依据", 12000, true), sourceUrl: url(payload.sourceUrl),
        authorized: true, dataClass: classValue, createdAt: now, recordedBy: inquiry.owner || company.owner || "", inquiryRevision: inquiry.revision };
      if (Date.parse(record.observedAt) > Date.parse(now)) error("FUTURE_OBSERVATION", "供货观察时间不能在未来。");
      if (Date.parse(record.validUntil) < Date.parse(record.observedAt)) error("INVALID_RANGE", "供货依据的有效期不能早于观察时间。");
      if (state.supplyReferences.length >= 500) error("SUPPLY_LIMIT", "演示工作区供货依据已达到 500 条。");
      state.supplyReferences.push(record); inquiry.revision += 1; inquiry.updatedAt = now;
      event(state, companyId, "supply_reference_added", "保存供货来源快照", { inquiryId: inquiry.id, sourceId: record.id, summary: "记录原始供货依据；没有锁定库存、安排发货或发送消息。" });
      return;
    }
    if (type === "save_commitment") {
      const inquiry = inquiryFor(state, text(payload.inquiryId, "询价编号", 100, true), companyId);
      revision(inquiry, payload.expectedRevision);
      if (payload.reviewed !== true) error("REVIEW_REQUIRED", "请先人工核对本次承诺草案及缺项。");
      const responsibleOwner = text(payload.owner, "负责人", 100, true);
      const assessment = assessCommitment(state, { ...payload, owner: responsibleOwner, companyId, inquiryId: inquiry.id });
      const record = { id: randomUUID(), companyId, inquiryId: inquiry.id, kind: assessment.kind, candidateId: assessment.candidateId, dueAt: assessment.dueAt, owner: assessment.owner,
        sourceText: inquiry.sourceText, sourceUrl: inquiry.sourceUrl, sourceFingerprint: assessment.sourceFingerprint, inputFingerprint: assessment.inputFingerprint, inquiryRevision: inquiry.revision,
        dataClass: inquiry.dataClass, reviewed: true, createdAt: now, status: "draft_saved", sent: false, stockReserved: false, assessment };
      if (state.commitmentRecords.length >= 500) error("COMMITMENT_LIMIT", "演示工作区核验记录已达到 500 条。");
      state.commitmentRecords.push(record); inquiry.revision += 1; inquiry.updatedAt = now;
      inquiry.history = [...(inquiry.history || []), { id: randomUUID(), at: now, type: "commitment_check", beforeFingerprint: assessment.inputFingerprint, afterFingerprint: assessment.inputFingerprint,
        beforeCandidates: inquiry.analysis.candidateIds || [], afterCandidates: inquiry.analysis.candidateIds || [], added: [], removed: [], changedFields: [], quoteInvalidated: false,
        commitmentId: record.id, owner: assessment.owner, sourceFingerprint: assessment.sourceFingerprint, result: assessment.status }].slice(-100);
      event(state, companyId, "commitment_draft_saved", "保存承诺草案核验记录", { inquiryId: inquiry.id, commitmentId: record.id, owner: assessment.owner, sourceFingerprint: assessment.sourceFingerprint, summary: assessment.status === "blocked" ? "核验仍有缺项；已保留责任人与原文，未发送承诺。" : "已保存供人工复核的草案；未发送承诺，也未预留库存。" });
      return;
    }
    if (type === "save_inquiry") {
      const id = text(payload.id, "询价编号", 100), previous = id ? inquiryFor(state, id, companyId) : null;
      if (previous) revision(previous, payload.expectedRevision);
      else if (state.inquiries.length >= 300) error("INQUIRY_LIMIT", "演示工作区询价已达到 300 条，请先导出整理。");
      const record = { id: id || randomUUID(), revision: previous ? previous.revision + 1 : 1, companyId,
        inputs: normalizeInputs(payload.inputs), sourceText: text(payload.sourceText, "询价原文", 20000, true), sourceUrl: url(payload.sourceUrl),
        channel: text(payload.channel, "来源渠道", 60), owner: text(payload.owner, "负责人", 100), nextFollowUpAt: date(payload.nextFollowUpAt, "跟进时间"),
        dataClass: dataClass(payload.dataClass), createdAt: previous?.createdAt || now, updatedAt: now };
      record.analysis = analyzeInquiry(record.inputs, options(state, record));
      record.customerSignals = detectCustomerSignals(record.sourceText);
      record.materialCalculations = (previous?.materialCalculations || []).map(item => ({ ...item, stale: item.stale === true || item.inquiryBasisHash !== materialInquiryBasisHash(record) }));
      record.history = [...(previous?.history || []), difference(previous, record, now)].slice(-100);
      if (previous) state.inquiries[state.inquiries.findIndex(i => i.id === id)] = record; else state.inquiries.push(record);
      followup(state, record, company, now);
      event(state, companyId, "inquiry_saved", previous ? "更新询价条件并重新核对" : "保存询价并安排需求确认", { inquiryId: record.id, summary: record.analysis.totalCandidates + " 条条件候选；" + (record.analysis.quoteStatus === "pending" ? "待核价" : "存在可比历史参考价") + "。没有代发回复。" });
    } else if (type === "add_quote_reference") {
      if (payload.authorized !== true) error("SOURCE_REQUIRED", "历史价必须由有权使用该资料的人员确认后录入。");
      const inquiryId = text(payload.inquiryId, "询价编号", 100), inquiry = inquiryId ? inquiryFor(state, inquiryId, companyId) : null;
      const inputs = normalizeInputs(payload.inputs || inquiry?.inputs);
      const record = { id: randomUUID(), companyId, inquiryId, partNumber: text(payload.partNumber, "件号", 120, true), namespace: text(payload.namespace, "编号体系", 30, true),
        sourceTitle: text(payload.sourceTitle, "来源名称", 200, true), sourceText: text(payload.sourceText, "原始价格依据", 12000, true), sourceUrl: url(payload.sourceUrl),
        dataClass: dataClass(payload.dataClass), authorized: true, inputs, specificationFingerprint: specificationFingerprint(inputs),
        quantityMin: positive(payload.quantityMin, "数量下限"), quantityMax: positive(payload.quantityMax, "数量上限"), unitPrice: positive(payload.unitPrice, "历史单价"),
        validFrom: date(payload.validFrom, "有效开始日期", true), validUntil: date(payload.validUntil, "有效结束日期", true, true), createdAt: now };
      for (const key of ["materialGrade", "currency", "unit", "incoterm", "destination", "accessories"]) record[key] = text(payload[key], key, 200, true);
      record.currency = record.currency.toUpperCase(); record.incoterm = record.incoterm.toUpperCase();
      if (!["WVA", "OE", "INTERNAL", "BFMC"].includes(record.namespace)) error("INVALID_NAMESPACE", "历史价必须注明明确的编号体系。");
      if (record.quantityMin > record.quantityMax || Date.parse(record.validFrom) > Date.parse(record.validUntil)) error("INVALID_RANGE", "数量或有效期的起止范围不正确。");
      if (inquiry && record.dataClass !== inquiry.dataClass) error("DATA_CLASS_MISMATCH", "演示价格不能录入真实询价，真实与演示资料需分开。");
      if (!state.fitmentCatalog.some(row => row.partNumber === record.partNumber && row.namespace === record.namespace)) error("UNVERIFIED_PART", "请使用候选中已核验的标准件号与编号体系录入历史价。");
      if (state.quoteHistory.length >= 500) error("QUOTE_LIMIT", "演示工作区历史价已达到 500 条。");
      state.quoteHistory.push(record);
      for (const item of state.inquiries.filter(i => i.companyId === companyId && (!inquiryId || i.id === inquiryId))) {
        item.analysis = analyzeInquiry(item.inputs, options(state, item)); item.updatedAt = now; item.revision += 1;
      }
      event(state, companyId, "quote_reference_added", "录入有来源的历史参考价", { inquiryId: inquiryId || undefined, summary: record.partNumber + " · " + record.currency + "/" + record.unit + " · " + record.incoterm + "。仅在可比条件及有效期内显示。" });
    } else if (type === "confirm_fitment") {
      if (payload.authorized !== true) error("SOURCE_REQUIRED", "人工核准需确认依据来自有权核准该配置的人员。");
      const inquiry = inquiryFor(state, text(payload.inquiryId, "询价编号", 100, true), companyId); revision(inquiry, payload.expectedRevision);
      const inputs = inquiry.inputs;
      if (inputs.partType === "unknown" || !((inputs.partCode && inputs.codeNamespace !== "unknown") || (inputs.axleModel && inputs.brakeSystem))) error("SCOPE_REQUIRED", "核准需注明片型，以及明确件号与编号体系，或具体车桥和制动器型号；品牌相同不足以核准。");
      const refreshed = analyzeInquiry(inputs, options(state, inquiry)), candidateId = text(payload.candidateId, "候选", 100, true);
      if (!refreshed.candidates.some(c => c.id === candidateId)) error("CANDIDATE_CHANGED", "该候选已不在当前条件结果中，请重新核对。");
      const scopeHash = specificationFingerprint(inputs);
      const relation = { id: randomUUID(), companyId, inquiryId: inquiry.id, candidateId, inputs: structuredClone(inputs), specificationFingerprint: scopeHash,
        sourceTitle: text(payload.sourceTitle, "核准依据名称", 200, true), sourceText: text(payload.sourceText, "核准原文", 12000, true), sourceUrl: url(payload.sourceUrl), confirmedBy: text(payload.confirmedBy, "核准人", 100, true),
        status: "confirmed", dataClass: inquiry.dataClass, confirmedAt: now };
      if (state.fitmentRelations.some(r => r.companyId === companyId && r.inquiryId === inquiry.id && r.candidateId === candidateId && r.specificationFingerprint === scopeHash)) error("ALREADY_CONFIRMED", "该询价配置已记录核准，无需重复提交。", 409);
      state.fitmentRelations.push(relation);
      inquiry.analysis = analyzeInquiry(inputs, options(state, inquiry)); inquiry.revision += 1; inquiry.updatedAt = now;
      followup(state, inquiry, company, now);
      event(state, companyId, "fitment_manually_confirmed", "保存限定配置的人工核准关系", { inquiryId: inquiry.id, summary: "核准保留原文与人员；改变配置后不会沿用原结论。报价和客户采购能力仍需分别核对。" });
    }
  });
}
