import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import Papa from "papaparse";
import { mutatePlatform } from "./store.mjs";
import { INQUIRY_ACTIONS, actInquiry } from "./inquiries.mjs";

export class PlatformError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; this.includeState = false; this.publicError = true; }
}
const short = (n = 200) => z.string().trim().max(n);
const date = z.string().max(64).refine(s => !s || Number.isFinite(Date.parse(s)), "日期格式无效");
const stages = ["待研究", "待联系", "已联系", "需求确认", "报价沟通", "样品沟通", "成交/维护", "暂停"];
const companyFields = z.object({
  name: short(160), website: short(2048).optional(), market: short(100).optional(),
  productRefs: z.array(short(120)).max(30).optional(), buyerRole: short(160).optional(),
  grade: z.enum(["A", "B", "C", "unknown"]).optional(), stage: z.enum(stages).optional(),
  owner: short(100).optional(), nextAction: short(1200).optional(), nextFollowUpAt: date.optional(),
  notes: short(12000).optional(), sourceUrl: short(2048).optional(), sourceKind: short(80).optional(),
});
function cleanUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value.includes("://") ? value : "https://" + value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw new PlatformError("INVALID_URL", "请输入有效的 HTTP(S) 公开网址。"); }
}
export function companyIdentity(company) {
  if (company.website) {
    const url = new URL(company.website);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (["facebook.com", "linkedin.com", "instagram.com", "alibaba.com", "made-in-china.com"].some(d => host === d || host.endsWith("." + d))) {
      return host + url.pathname.replace(/\/$/, "") + (url.searchParams.get("id") ? "?id=" + url.searchParams.get("id") : "");
    }
    return host;
  }
  return "name:" + company.name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim() + "|" + (company.market || "").toLowerCase();
}
export function sameCompany(left, right) {
  const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return companyIdentity(left) === companyIdentity(right)
    || (normalize(left.name) && normalize(left.name) === normalize(right.name) && normalize(left.market) === normalize(right.market));
}
export function appendEvent(state, companyId, type, title, extra = {}) {
  state.events.push({ id: randomUUID(), companyId, type, title, createdAt: new Date().toISOString(), ...extra });
}
function missingFor(company) {
  const missing = [];
  if (!company.website) missing.push("企业官网待核验");
  if (!company.productRefs.length) missing.push("产品关联待核验");
  if (!company.buyerRole || /待|未知/.test(company.buyerRole)) missing.push("采购渠道角色待确认");
  if (!company.contacts.length) missing.push("公开商务联系入口待补充");
  missing.push("本次采购需求与数量待确认");
  return missing;
}
function makeCompany(payload) {
  const parsed = companyFields.parse(payload);
  if (!parsed.name) throw new PlatformError("NAME_REQUIRED", "请填写企业名称。");
  const now = new Date().toISOString();
  const company = {
    id: randomUUID(), name: parsed.name, website: cleanUrl(parsed.website || ""), market: parsed.market || "",
    productRefs: parsed.productRefs || [], buyerRole: parsed.buyerRole || "待核验",
    grade: parsed.grade || "unknown", gradeSource: parsed.grade && parsed.grade !== "unknown" ? "manual" : "unknown",
    stage: parsed.stage || "待研究", owner: parsed.owner || "", nextAction: parsed.nextAction || "核对产品关联与采购角色",
    nextFollowUpAt: parsed.nextFollowUpAt || "", notes: parsed.notes || "",
    sourceUrl: cleanUrl(parsed.sourceUrl || ""), sourceKind: parsed.sourceKind || "manual",
    evidence: [], communications: [], contacts: [], memoryProposals: [], memoryHistory: [], memoryByInquiry: {}, researchStatus: "not_started",
    revision: 1, createdAt: now, updatedAt: now, dataClass: "real",
  };
  if (company.notes) company.evidence.push({
    id: randomUUID(), type: "manual", title: "业务员导入资料", url: company.sourceUrl || undefined,
    snippet: company.notes, capturedAt: now, status: "reported",
  });
  company.missingEvidence = missingFor(company);
  return company;
}
function findCompany(state, id) {
  const company = state.companies.find(c => c.id === id);
  if (!company) throw new PlatformError("NOT_FOUND", "没有找到该企业。", 404);
  return company;
}
export async function act(type, payload = {}) {
  if (INQUIRY_ACTIONS.has(type)) return actInquiry(type, payload);
  return mutatePlatform(state => {
    if (type === "create_company") {
      const company = makeCompany(payload);
      if (state.companies.some(c => sameCompany(c, company))) throw new PlatformError("DUPLICATE_COMPANY", "该企业已存在，请编辑原有记录。", 409);
      state.companies.push(company);
      appendEvent(state, company.id, "company_created", "添加待核验企业", { sourceKind: company.sourceKind });
    } else if (type === "update_company") {
      const id = z.string().parse(payload.id);
      const company = findCompany(state, id);
      if (!Number.isInteger(payload.expectedRevision)) throw new PlatformError("REVISION_REQUIRED", "更新时需要所读取的记录版本，请刷新后重试。", 409);
      if (payload.expectedRevision !== company.revision) throw new PlatformError("REVISION_CONFLICT", "记录已更新，请刷新后重试。", 409);
      const patch = companyFields.partial().parse(payload);
      if (patch.name === "") throw new PlatformError("NAME_REQUIRED", "企业名称不能为空。");
      if (patch.website !== undefined) patch.website = cleanUrl(patch.website);
      if (patch.sourceUrl !== undefined) patch.sourceUrl = cleanUrl(patch.sourceUrl);
      const proposed = { ...company, ...patch };
      if (state.companies.some(c => c.id !== id && sameCompany(c, proposed))) throw new PlatformError("DUPLICATE_COMPANY", "该网址或企业标识已被另一记录使用。", 409);
      const before = Object.fromEntries(Object.keys(patch).map(k => [k, company[k]]));
      if (patch.website !== undefined && patch.website !== company.website) {
        company.researchHistory ||= [];
        company.researchHistory.push({
          archivedAt: new Date().toISOString(), website: company.website,
          evidence: company.evidence.filter(e => e.type === "webpage"),
          contacts: company.contacts.filter(c => c.verification === "public_page"),
          websiteFacts: company.websiteFacts || [], question: company.lastQuestion || "",
          reason: "企业官网发生变化；旧研究只留历史，不应用到新网址",
        });
        company.evidence = company.evidence.filter(e => e.type !== "webpage");
        company.contacts = company.contacts.filter(c => c.verification !== "public_page");
        company.websiteFacts = []; company.researchProductMatches = []; company.openingQuestionEvidence = null;
        company.lastQuestion = ""; company.suggestedNextAction = ""; company.lastResearchAt = null;
        company.lastResearchFingerprint = null; company.researchStatus = "not_started"; company.researchError = "";
        if (company.gradeSource === "evidence_rule") { company.grade = "unknown"; company.gradeSource = "unknown"; }
      }
      Object.assign(company, patch, { revision: company.revision + 1, updatedAt: new Date().toISOString() });
      const memoryKeys = ["productRefs", "buyerRole", "nextAction", "stage"].filter(key => patch[key] !== undefined && JSON.stringify(before[key]) !== JSON.stringify(patch[key]));
      if (memoryKeys.length) {
        company.memoryByInquiry ||= {};
        const memory = company.memoryByInquiry.general ||= { values: {}, fieldTimes: {} };
        for (const key of memoryKeys) { memory.values[key] = patch[key]; memory.fieldTimes[key] = company.updatedAt; }
      }
      if (patch.grade !== undefined) company.gradeSource = "manual";
      company.missingEvidence = missingFor(company);
      appendEvent(state, id, "company_updated", "更新客户安排", { before, after: patch });
    } else if (type === "add_communication") {
      const input = z.object({
        companyId: z.string(), text: short(20000).min(1), occurredAt: date.optional(),
        dataClass: z.enum(["real", "synthetic"]).optional(),
      }).parse(payload);
      const company = findCompany(state, input.companyId);
      const hash = createHash("sha256").update(company.id + "\n" + input.text + "\n" + (input.occurredAt || "")).digest("hex");
      if (company.communications.some(c => c.contentHash === hash)) return;
      const now = new Date().toISOString();
      const message = { id: randomUUID(), text: input.text, occurredAt: input.occurredAt || "", recordedAt: now, contentHash: hash, dataClass: input.dataClass || "real" };
      company.communications.push(message);
      company.evidence.push({ id: message.id, type: "manual", title: "沟通原文", snippet: input.text, capturedAt: now, status: "reported" });
      company.updatedAt = now; company.revision += 1;
      if (input.occurredAt && (!company.lastContactAt || Date.parse(input.occurredAt) > Date.parse(company.lastContactAt))) company.lastContactAt = input.occurredAt;
      appendEvent(state, company.id, "communication_added", "保存沟通原文", { text: input.text, occurredAt: input.occurredAt || null, summary: "保留原话与业务时间；未自动改写采购数量或成交状态。" });
    } else if (type === "propose_memory") {
      const input = z.object({
        companyId: z.string(), communicationId: z.string().optional(),
        inquiryId: short(100).default("general"), occurredAt: date,
        patch: z.object({
          productRefs: z.array(short(120)).max(30).optional(), buyerRole: short(160).optional(),
          nextAction: short(1200).optional(), stage: z.enum(stages).optional(),
          lossReason: short(1200).optional(),
        }).strict(),
        reason: short(1200).optional(), sourceText: short(20000).optional(),
      }).parse(payload);
      if (!input.occurredAt) throw new PlatformError("SOURCE_TIME_REQUIRED", "请填写沟通实际发生时间，才能判断新旧记录。");
      if (!Object.keys(input.patch).length) throw new PlatformError("EMPTY_PATCH", "至少提出一个字段更新。");
      const company = findCompany(state, input.companyId);
      const communication = input.communicationId ? company.communications.find(c => c.id === input.communicationId) : null;
      if (input.communicationId && !communication) throw new PlatformError("SOURCE_NOT_FOUND", "没有找到该客户的沟通原文。", 404);
      const sourceText = communication?.text || input.sourceText;
      if (!sourceText) throw new PlatformError("SOURCE_REQUIRED", "请先保存沟通原文，或为这次更新填写原始依据。");
      const occurredAt = communication?.occurredAt || input.occurredAt;
      if (communication?.occurredAt && Date.parse(input.occurredAt) !== Date.parse(communication.occurredAt)) throw new PlatformError("SOURCE_TIME_MISMATCH", "更新建议的时间需与所选沟通记录的发生时间一致。");
      company.memoryProposals ||= []; company.memoryByInquiry ||= {}; company.memoryHistory ||= [];
      const currentMemory = company.memoryByInquiry[input.inquiryId]?.values || {};
      const originalValues = Object.fromEntries(Object.keys(input.patch).map(key => [key, currentMemory[key] ?? (input.inquiryId === "general" ? company[key] : undefined) ?? (key === "productRefs" ? [] : "")]));
      const patch = Object.fromEntries(Object.entries(input.patch).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(originalValues[key])));
      if (!Object.keys(patch).length) throw new PlatformError("EMPTY_PATCH", "原值和新值相同，没有需要确认的变化。");
      const before = Object.fromEntries(Object.keys(patch).map(key => [key, originalValues[key]]));
      const idempotencyKey = createHash("sha256").update(JSON.stringify({ sourceText, occurredAt, inquiryId: input.inquiryId, patch })).digest("hex");
      if (company.memoryProposals.some(p => p.idempotencyKey === idempotencyKey)) return;
      company.memoryProposals.push({
        id: randomUUID(), inquiryId: input.inquiryId, status: "pending", before, after: patch,
        sourceText, communicationId: communication?.id || null, occurredAt,
        createdAt: new Date().toISOString(), reason: input.reason || "业务员基于沟通原文提出；待人工确认",
        idempotencyKey, extractionMethod: "human_proposed", baseRevision: company.revision,
      });
      company.revision += 1;
      appendEvent(state, company.id, "memory_proposed", "提出客户记忆更新", { inquiryId: input.inquiryId, summary: "已保存原值、新值和来源，尚未应用。" });
    } else if (type === "cancel_memory") {
      const input = z.object({ companyId: z.string(), proposalId: z.string() }).parse(payload);
      const company = findCompany(state, input.companyId);
      const proposal = (company.memoryProposals || []).find(p => p.id === input.proposalId);
      if (!proposal) throw new PlatformError("NOT_FOUND", "没有找到更新建议。", 404);
      if (proposal.status === "cancelled") return;
      if (proposal.status !== "pending") throw new PlatformError("MEMORY_NOT_PENDING", "该建议已处理，不能取消。", 409);
      proposal.status = "cancelled"; proposal.cancelledAt = new Date().toISOString();
      company.revision += 1; company.updatedAt = proposal.cancelledAt;
      appendEvent(state, company.id, "memory_cancelled", "取消客户记忆更新", { inquiryId: proposal.inquiryId, summary: "保留提议与来源，客户资料未应用变化。" });
    } else if (type === "apply_memory") {
      const input = z.object({ companyId: z.string(), proposalId: z.string() }).parse(payload);
      const company = findCompany(state, input.companyId);
      const proposal = (company.memoryProposals || []).find(p => p.id === input.proposalId);
      if (!proposal) throw new PlatformError("NOT_FOUND", "没有找到更新建议。", 404);
      if (proposal.status === "applied") return;
      if (proposal.status !== "pending") throw new PlatformError("MEMORY_NOT_PENDING", "该建议已取消或已失效，未修改客户记忆。", 409);
      company.memoryByInquiry ||= {}; company.memoryHistory ||= [];
      const memory = company.memoryByInquiry[proposal.inquiryId] ||= { values: {}, fieldTimes: {} };
      for (const key of Object.keys(proposal.after)) {
        if (memory.fieldTimes[key] && Date.parse(memory.fieldTimes[key]) > Date.parse(proposal.occurredAt)) throw new PlatformError("STALE_MEMORY", "这条消息早于已确认的新修正，不能覆盖当前记忆。", 409);
        const current = memory.values[key] ?? (proposal.inquiryId === "general" ? company[key] : undefined) ?? (key === "productRefs" ? [] : "");
        if (JSON.stringify(current) !== JSON.stringify(proposal.before[key])) throw new PlatformError("MEMORY_CONFLICT", "待确认期间资料已变化，请重新比较原文与现值。", 409);
      }
      const appliedAt = new Date().toISOString();
      const history = { id: randomUUID(), proposalId: proposal.id, inquiryId: proposal.inquiryId, before: proposal.before, after: proposal.after, sourceText: proposal.sourceText, occurredAt: proposal.occurredAt, appliedAt, confirmedBy: "local_operator" };
      company.memoryHistory.push(history);
      for (const [key, value] of Object.entries(proposal.after)) {
        memory.values[key] = value; memory.fieldTimes[key] = proposal.occurredAt;
        if (proposal.inquiryId === "general") company[key] = value;
      }
      if (proposal.after.lossReason) company.nextScreeningSuggestion = {
        status: "pending_review", sourceProposalId: proposal.id,
        text: "下一轮人工筛选时补问：" + proposal.after.lossReason + "。仅来自该客户的单次反馈，尚不能推广到该国或同类企业。",
        createdAt: appliedAt,
      };
      proposal.status = "applied"; proposal.appliedAt = appliedAt;
      company.revision += 1; company.updatedAt = appliedAt;
      appendEvent(state, company.id, "memory_applied", "人工确认并更新客户记忆", { inquiryId: proposal.inquiryId, before: proposal.before, after: proposal.after, occurredAt: proposal.occurredAt, summary: "保留旧值、来源、发生时间和确认时间。" });
    } else if (type === "add_task") {
      const task = z.object({ companyId: z.string(), title: short(400).min(1), dueAt: date.refine(Boolean, "请填写跟进时间"), owner: short(100).optional() }).parse(payload);
      findCompany(state, task.companyId);
      state.tasks.push({ id: randomUUID(), ...task, status: "open", createdAt: new Date().toISOString() });
      appendEvent(state, task.companyId, "task_added", "安排跟进", { summary: task.title });
    } else if (type === "update_task") {
      const patch = z.object({ id: z.string(), status: z.enum(["open", "done"]) }).parse(payload);
      const task = state.tasks.find(t => t.id === patch.id);
      if (!task) throw new PlatformError("NOT_FOUND", "没有找到该跟进事项。", 404);
      task.status = patch.status; task.updatedAt = new Date().toISOString();
      appendEvent(state, task.companyId, "task_updated", patch.status === "done" ? "完成跟进事项" : "重新打开跟进事项", { summary: task.title });
    } else if (type === "create_product") {
      const product = z.object({
        name: short(200).min(1), category: short(100), codes: z.array(z.object({ namespace: z.enum(["HS", "WVA", "OE", "INTERNAL"]), value: short(120).min(1) })).max(30),
        source: short(2000), notes: short(5000).optional(),
      }).parse(payload);
      state.products.push({ id: randomUUID(), ...product });
      appendEvent(state, null, "product_created", "添加产品锚点", { summary: product.name });
    } else if (type === "load_demo") {
      loadVerifiedExample(state);
    } else throw new PlatformError("UNKNOWN_ACTION", "不支持的操作。");
  });
}

function loadVerifiedExample(state) {
  for (const code of ["19488", "19486", "19487", "19032"]) {
    const id = "product-brake-lining-" + code;
    if (!state.products.some(p => p.id === id)) state.products.push({
      id, name: "鼓式刹车片 · WVA " + code, category: "brake_lining",
      codes: [{ namespace: "WVA", value: code }, { namespace: "HS", value: "6813810000" }],
      source: "企业官方问答资料（用户授权）：Brake lining / HS 6813810000，占比约85%，列出常见询盘WVA编号",
      notes: "企业主推鼓式类别的独立编号参考，四个WVA不是同一SKU。没有确认尺寸适配、供货、MOQ或报价；HS仅作类别筛选。Proxel仅为欧洲拓展示例，不代表企业主市场。",
    });
  }
  if (!state.products.some(p => p.id === "product-wva-29181")) state.products.push({
    id: "product-wva-29181", name: "SA-010 / WVA 29181 盘式刹车片", category: "disc_brake_pad",
    codes: [{ namespace: "WVA", value: "29181" }, { namespace: "INTERNAL", value: "SA-010" }],
    source: "冠英授权官方产品照片：SA-010 / 29181，人工核验",
    imageUrl: "/platform/product-29181.jpg",
    notes: "照片标示 210×93.5×30 mm，包装 12 片；包装数不是 MOQ。与 OE 3054005300 制动蹄是不同产品，不能互相替代。",
  });
  const productId = "product-saf-shoe-420-200";
  if (!state.products.some(p => p.id === productId)) state.products.push({
    id: productId, name: "SAF 420×200 制动蹄", category: "brake_shoe",
    codes: [{ namespace: "OE", value: "3054005300" }],
    source: "冠英官方英文产品目录，第 34 个 PDF 页面（印刷页码 65），人工核验",
    notes: "与衬片 WVA 19477/19478 是关联关系；不得与盘式刹车片 WVA 29181 混为同一产品。准确适配、供货与交期待企业确认。",
  });
  if (state.companies.some(c => c.website && new URL(c.website).hostname.replace(/^www\./, "") === "proxel.fi")) return;
  const company = makeCompany({ name: "Proxel Oy", website: "https://www.proxel.fi/", market: "芬兰",
    buyerRole: "重型车配件经营企业；官网自述进口业务", productRefs: ["OE 3054005300"],
    sourceKind: "seed", grade: "unknown", nextAction: "核对型号与是否接受备选供应来源；采购计划仍未知",
    notes: "已核查公开资料样例，查阅日期 2026-11-21。不是本次模型输出，也不是冠英已联系客户。" });
  company.isDemo = true;
  company.researchStatus = "evidence_only";
  company.evidence = [
    { id: randomUUID(), type: "webpage", title: "官网产品页（已核查资料样例）", url: "https://www.proxel.fi/en/products/brake/brake-shoe-saf-420x200-22", snippet: 'BRAKE SHOE SAF 420x200 22"; Ref. number: 3054005300; Backorder.', capturedAt: "2026-11-21", status: "observed" },
    { id: randomUUID(), type: "webpage", title: "官网企业介绍（已核查资料样例）", url: "https://www.proxel.fi/en/meista", snippet: "Our selection covers spare parts for buses, trucks, trailers, and work machinery. 中文摘要：官网另自述进口业务经验。", capturedAt: "2026-11-21", status: "reported" },
    { id: randomUUID(), type: "webpage", title: "官网联系页（已核查资料样例）", url: "https://www.proxel.fi/en/yhteystiedot", snippet: "management, spare parts sales and purchasing — Jeri Eljander — jeri.eljander@proxel.fi", capturedAt: "2026-11-21", status: "observed" },
  ];
  company.contacts = [{ type: "email", value: "jeri.eljander@proxel.fi", role: "官网职责包含 spare parts sales and purchasing", sourceUrl: "https://www.proxel.fi/en/yhteystiedot", verification: "public_page" }];
  company.missingEvidence = ["当前采购计划未知", "规格适配与实际供货待确认", "公开联系方式尚未验证投递结果"];
  state.companies.push(company);
  appendEvent(state, company.id, "seed_loaded", "加载已核查资料样例", { summary: "公开来源样例；不是实时查询、模型输出、已联系或已成交客户。" });
}

export async function importCompanies(csv) {
  if (typeof csv !== "string" || Buffer.byteLength(csv, "utf8") > 2 * 1024 * 1024) throw new PlatformError("CSV_TOO_LARGE", "CSV 需为 2 MB 以内文本。", 413);
  const parsed = Papa.parse(csv.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: h => h.trim() });
  if (parsed.errors.some(e => e.type === "Quotes")) throw new PlatformError("INVALID_CSV", "CSV 引号格式不完整。");
  if (!parsed.data.length) throw new PlatformError("CSV_EMPTY", "CSV 没有可导入的数据行；请保留表头并添加企业记录。", 422);
  const nameHeaders = ["name", "company", "company_name", "企业名称", "公司名", "公司名称"];
  if (!nameHeaders.some(header => parsed.meta.fields?.includes(header))) throw new PlatformError("CSV_NAME_COLUMN_REQUIRED", "CSV 缺少企业名称列；请使用 name、company、企业名称或公司名称作为表头。", 422);
  if (parsed.data.length > 1000) throw new PlatformError("ROW_LIMIT", "本次最多导入 1000 行，请分批处理。");
  const summary = { imported: 0, duplicates: 0, rejected: [], inputRows: parsed.data.length };
  const result = await mutatePlatform(state => {
    const identities = new Set(state.companies.map(companyIdentity));
    for (const [index, row] of parsed.data.entries()) {
      const pick = (...names) => names.map(n => row[n]).find(v => typeof v === "string" && v.trim()) || "";
      try {
        const company = makeCompany({
          name: pick(...nameHeaders),
          website: pick("website", "url", "官网"), market: pick("market", "country", "国家", "市场"),
          productRefs: pick("productRefs", "product_refs", "产品编号").split(/[,，;；|]+/).map(s => s.trim()).filter(Boolean),
          buyerRole: pick("buyerRole", "buyer_role", "客户角色"), owner: pick("owner", "负责人"),
          notes: pick("notes", "备注", "原文"), sourceUrl: pick("sourceUrl", "source_url", "来源"),
          sourceKind: "csv_import",
        });
        const identity = companyIdentity(company);
        if (identities.has(identity) || state.companies.some(c => sameCompany(c, company))) { summary.duplicates += 1; continue; }
        identities.add(identity); state.companies.push(company); summary.imported += 1;
      } catch (error) { summary.rejected.push({ row: index + 2, reason: error instanceof PlatformError ? error.message : "字段格式或长度不符合要求" }); }
    }
    state.lastImport = { ...summary, completedAt: new Date().toISOString(), modelRequests: 0 };
    appendEvent(state, null, "csv_imported", "批量导入客户线索", { summary: "新增 " + summary.imported + "；重复 " + summary.duplicates + "；拒绝 " + summary.rejected.length + "。未调用模型。" });
  });
  if (!summary.imported && !summary.duplicates && summary.rejected.length) {
    const first = summary.rejected[0];
    const error = new PlatformError("CSV_NO_VALID_ROWS", "没有导入有效记录，" + summary.rejected.length + " 行需要更正。第 " + first.row + " 行：" + first.reason + "。原 CSV 已保留，可修改后重试。", 422);
    error.includeState = true;
    throw error;
  }
  return { state: result, summary };
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export function exportCsv(state) {
  const headers = ["企业名称", "官网", "国家市场", "产品关联", "客户角色", "人工分级", "业务阶段", "负责人", "下次跟进", "下一步", "公开联系入口", "证据来源", "待补证", "资料样例"];
  const rows = state.companies.map(c => [
    c.name, c.website, c.market, c.productRefs.join("; "), c.buyerRole, c.grade, c.stage, c.owner,
    c.nextFollowUpAt, c.nextAction, c.contacts.map(x => x.type + ": " + x.value).join("; "),
    c.evidence.map(e => e.url).filter(Boolean).join("; "), c.missingEvidence.join("; "), c.isDemo ? "已核查公开资料样例" : "",
  ]);
  return "\uFEFF" + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
