import { createHash, randomUUID } from "node:crypto";
import { mutatePlatform, readRaw } from "./store.mjs";

export const FINANCIAL_NUMBER_FIELDS = ["currentAssets", "currentLiabilities", "operatingCashFlow", "netIncome"];
export const FINANCIAL_REPORT_FIELDS = ["entityName", "scope", "balanceDate", "periodStart", "periodEnd", "currency", "scale", ...FINANCIAL_NUMBER_FIELDS];
const currencies = new Set(Intl.supportedValuesOf("currency"));
const scales = ["1", "1000", "10000", "1000000"];
const MICRO = 1000000n;
export function financialError(code, message, status = 400) { return Object.assign(new Error(message), { code, status, publicError: true }); }
function fail(code, message, status = 400) { throw financialError(code, message, status); }
export function financialSourceHash(text) { return createHash("sha256").update(text).digest("hex"); }
function field(value, label, limit = 200, required = false) {
  if (value != null && typeof value !== "string") fail("FINANCIAL_FIELD_INVALID", label + " 必须是文本；未知字段留空。");
  const raw = (value || "").trim(); if (raw.length > limit || (required && !raw)) fail("FINANCIAL_FIELD_INVALID", label + " 缺失或超出长度上限。"); return raw;
}
export function financialDate(value, label) {
  const raw = field(value, label, 10);
  if (!raw) return "";
  const date = new Date(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) fail("FINANCIAL_DATE_INVALID", label + " 必须是有效 YYYY-MM-DD 日期。");
  return raw;
}
export function parseFinancialNumber(value, fieldName) {
  const raw = field(value, fieldName, 100);
  if (!raw || /^(?:[-—–]|n\/?a|null|unknown|未知|未披露)$/i.test(raw)) return { value: null, units: null };
  let numeric = raw.normalize("NFKC").replace(/−/g, "-");
  if (/^\(.*\)$/.test(numeric)) numeric = "-" + numeric.slice(1, -1).trim();
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,6})?$/.test(numeric)) fail("FINANCIAL_NUMBER_INVALID", fieldName + " 请人工核对为明确数值；不接受币种符号、科学计数或不明确的小数/千分位。");
  numeric = numeric.replace(/,/g, "");
  const negative = numeric.startsWith("-"), unsigned = numeric.replace(/^[+-]/, ""), [whole, fraction = ""] = unsigned.split(".");
  if (whole.length > 24) fail("FINANCIAL_NUMBER_INVALID", "金额过长，请检查报表单位，未自动换算。");
  const units = (BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, "0"))) * (negative ? -1n : 1n);
  if (["currentAssets", "currentLiabilities"].includes(fieldName) && units < 0n) fail("FINANCIAL_NEGATIVE_BALANCE", "流动资产或流动负债不能以负数通过本项核验，请核对行名、符号和报表列。");
  return { value: formatMoney(units), units };
}
function formatMoney(units) {
  const negative = units < 0n, n = negative ? -units : units, fraction = (n % MICRO).toString().padStart(6, "0").replace(/0+$/, "");
  return (negative ? "-" : "") + (n / MICRO).toString() + (fraction ? "." + fraction : "");
}
function ratio(a, b) {
  const n = (a * 10000n + b / 2n) / b, fraction = (n % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return (n / 10000n).toString() + (fraction ? "." + fraction : "");
}
export function validateFinancialSource(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("FINANCIAL_INPUT_INVALID", "财务资料请求格式无效。");
  if (payload.authorized !== true) fail("FINANCIAL_AUTH_REQUIRED", "请确认资料来自公开披露或你有权使用的授权来源。");
  if (!["real", "synthetic"].includes(payload.dataClass)) fail("DATA_CLASS_REQUIRED", "请明确选择真实资料或演示样例。");
  if (typeof payload.sourceText !== "string" || !payload.sourceText.trim() || payload.sourceText.length > 16000) fail("FINANCIAL_SOURCE_INVALID", "请粘贴 1—16000 字符的报表原文；PDF 请复制可选文字，本功能没有 PDF/OCR 解析器。");
  let sourceUrl = field(payload.sourceUrl, "来源链接", 2048);
  if (sourceUrl) {
    try { const parsed = new URL(sourceUrl); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); sourceUrl = parsed.href; }
    catch { fail("FINANCIAL_SOURCE_URL", "来源链接应是有效 HTTP(S) 地址。"); }
  }
  return { companyId: field(payload.companyId, "关联客户", 100, true), sourceText: payload.sourceText, sourceName: field(payload.sourceName, "来源名称", 200, true),
    sourcePage: field(payload.sourcePage, "来源页码/段落", 200), sourceUrl, authorized: true, dataClass: payload.dataClass };
}
export function financialCompany(state, companyId, dataClass) {
  const company = state.companies.find(c => c.id === companyId);
  if (!company) fail("NOT_FOUND", "当前工作区没有该企业。", 404);
  const classValue = company.dataClass === "synthetic" || company.isDemo ? "synthetic" : "real";
  if (classValue !== dataClass) fail("DATA_CLASS_MISMATCH", "真实企业和演示财报不能混合关联。");
  return company;
}
export function calculateFinancialReview(payload, company) {
  const source = validateFinancialSource(payload), raw = payload.report || {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("FINANCIAL_REPORT_INVALID", "报表字段格式无效。");
  const report = { entityName: field(raw.entityName, "报表主体", 200), entityRelation: field(raw.entityRelation, "主体关系", 30) || "unknown",
    scope: field(raw.scope, "合并或单体口径", 30) || "unknown", balanceDate: financialDate(raw.balanceDate, "资产负债表日"),
    periodStart: financialDate(raw.periodStart, "期间开始"), periodEnd: financialDate(raw.periodEnd, "期间结束"), currency: field(raw.currency, "币种", 3).toUpperCase(), scale: field(raw.scale, "报表单位", 20) };
  if (!["customer", "parent_group", "other", "unknown"].includes(report.entityRelation) || !["standalone", "consolidated", "unknown"].includes(report.scope)) fail("FINANCIAL_SCOPE_INVALID", "请选择明确的主体关系与报表口径；未知时留待核对。");
  if (report.currency && !currencies.has(report.currency)) fail("FINANCIAL_CURRENCY_INVALID", "请人工核对明确的 ISO 币种代码；$、¥ 等符号不会自动推定币种。");
  if (report.scale && !scales.includes(report.scale)) fail("FINANCIAL_SCALE_INVALID", "单位只支持明确的 1、1000、10000、1000000；未知时留空。");
  if (report.periodStart && report.periodEnd && report.periodStart > report.periodEnd) fail("FINANCIAL_PERIOD_INVALID", "报告期间开始不能晚于结束。");
  if (report.periodEnd && report.balanceDate && report.periodEnd !== report.balanceDate) fail("FINANCIAL_PERIOD_MISMATCH", "本次最小核验要求资产负债表日与现金流/利润期间结束日一致，请分开核对不同期间。");
  const amounts = {};
  for (const key of FINANCIAL_NUMBER_FIELDS) { amounts[key] = parseFinancialNumber(raw[key], key); report[key] = amounts[key].value === null ? "" : amounts[key].value; }
  const confirmations = { identity: payload.confirmations?.identity === true, basis: payload.confirmations?.basis === true };
  const reviewer = field(payload.reviewer, "核验人员", 100), missing = [], warnings = [];
  for (const [key, label] of [["entityName", "报表主体"], ["balanceDate", "资产负债表日"], ["periodStart", "报告期间开始"], ["periodEnd", "报告期间结束"], ["currency", "币种"], ["scale", "金额单位"]]) if (!report[key]) missing.push(label + "待核对");
  if (report.scope === "unknown") missing.push("合并/单体口径待核对");
  if (report.entityRelation === "unknown") missing.push("报表主体与客户关系待核对");
  if (!confirmations.identity) missing.push("需人工确认报表主体关系");
  if (!confirmations.basis) missing.push("需人工确认四数期间、币种、单位及报表列口径");
  const businessToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if ((report.balanceDate && report.balanceDate > businessToday) || (report.periodEnd && report.periodEnd > businessToday)) missing.push("报表截止日期在未来，不能按已发生历史财报计算；请核对是否预测数据或日期录错");
  const basisReady = missing.length === 0;
  if (!reviewer) missing.push("核验人员待填写");
  for (const key of FINANCIAL_NUMBER_FIELDS) if (amounts[key].units === null) missing.push(key + " 未披露或未核对；未按 0 处理");
  if (!source.sourcePage) warnings.push("未注明来源页码/段落，请尽量补充以便复核。");
  if (report.scope === "consolidated" || report.entityRelation === "parent_group") warnings.push("这是合并报表或集团资料，只反映所述报表范围，不能当作客户子公司/单体的财务证据。");
  if (report.entityRelation === "other") warnings.push("该报表主体不是所选客户，仅保留来源核验记录，不能归因于客户。");
  const stateOf = (...keys) => !basisReady ? "unconfirmed" : keys.some(key => amounts[key].units === null) ? "missing" : "calculated";
  const metrics = {
    currentRatio: { value: null, status: stateOf("currentAssets", "currentLiabilities"), formula: "CA / CL" },
    workingCapital: { value: null, baseValue: null, status: stateOf("currentAssets", "currentLiabilities"), formula: "CA - CL", currency: report.currency, scale: report.scale },
    operatingCashFlow: { value: basisReady ? amounts.operatingCashFlow.value : null, baseValue: basisReady && amounts.operatingCashFlow.units !== null ? formatMoney(amounts.operatingCashFlow.units * BigInt(report.scale)) : null, currency: report.currency, scale: report.scale },
    netIncome: { value: basisReady ? amounts.netIncome.value : null, baseValue: basisReady && amounts.netIncome.units !== null ? formatMoney(amounts.netIncome.units * BigInt(report.scale)) : null, currency: report.currency, scale: report.scale },
  };
  if (metrics.currentRatio.status === "calculated") {
    if (amounts.currentLiabilities.units === 0n) { metrics.currentRatio.status = "zero_denominator"; warnings.push("流动负债为 0，未计算流动比率，不显示 Infinity 或据此作信用结论。"); }
    else metrics.currentRatio.value = ratio(amounts.currentAssets.units, amounts.currentLiabilities.units);
    const working = amounts.currentAssets.units - amounts.currentLiabilities.units;
    metrics.workingCapital.value = formatMoney(working); metrics.workingCapital.baseValue = formatMoney(working * BigInt(report.scale));
  }
  if (basisReady && amounts.operatingCashFlow.units !== null && amounts.netIncome.units !== null && amounts.operatingCashFlow.units < 0n && amounts.netIncome.units > 0n) warnings.push("本期间经营现金流为负、净利润为正，两者含义不同；请核对现金流调节及报表说明，不能据此认定无付款能力。");
  const sourceHash = financialSourceHash(source.sourceText);
  const reviewHash = financialSourceHash(JSON.stringify({ source, sourceHash, report, confirmations, reviewer, company: { id: company.id, name: company.name }, version: "financial-review-1" }));
  return { status: missing.length ? "incomplete" : "reviewed", report, confirmations, reviewer, metrics, missing, warnings, reviewHash, sourceHash, companyId: company.id, companyName: company.name, dataClass: source.dataClass,
    appliesToCustomer: basisReady && report.scope === "standalone" && report.entityRelation === "customer",
    notice: "仅核对所注明主体、期间与口径的历史报表。缺报表不等于无力付款，历史数据不证明现在能付款；本工具不修改客户等级、不授信、不批准账期。" };
}
export async function reviewFinancialReport(payload) {
  const source = validateFinancialSource(payload), { state } = await readRaw(), company = financialCompany(state, source.companyId, source.dataClass);
  return calculateFinancialReview(payload, company);
}
export async function saveFinancialReview(payload) {
  const source = validateFinancialSource(payload);
  if (!field(payload.reviewer, "核验人员", 100)) fail("FINANCIAL_REVIEWER_REQUIRED", "保存前请填写负责本次核对的人员。");
  const meta = { id: "", duplicate: false };
  const state = await mutatePlatform(next => {
    next.financialReviews ||= [];
    const company = financialCompany(next, source.companyId, source.dataClass), result = calculateFinancialReview(payload, company);
    if (payload.reviewHash !== result.reviewHash) fail("FINANCIAL_REVIEW_CHANGED", "原文、主体、期间、口径或核验信息已变化，请重新核验后保存。", 409);
    const existing = next.financialReviews.find(row => row.companyId === company.id && row.dataClass === source.dataClass && row.reviewHash === result.reviewHash);
    if (existing) { meta.id = existing.id; meta.duplicate = true; return; }
    const record = { id: randomUUID(), ...source, report: result.report, reviewer: result.reviewer, confirmations: result.confirmations, reviewHash: result.reviewHash, sourceHash: result.sourceHash, result, createdAt: new Date().toISOString() };
    next.financialReviews.push(record); meta.id = record.id;
    next.events.push({ id: randomUUID(), companyId: company.id, type: "financial_review_saved", title: "保存财务资料人工核验记录", createdAt: record.createdAt, financialReviewId: record.id,
      summary: "保留报表主体、口径、期间、来源与核验人；未更改客户等级、付款能力判断或授信安排。" });
  });
  return { state, meta };
}
