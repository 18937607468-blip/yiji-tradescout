import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { calculateFinancialReview, reviewFinancialReport, saveFinancialReview, financialSourceHash } from "../lib/platform/financial-review.mjs";
import { validateFinancialExtraction, extractFinancialReport } from "../lib/platform/financial-extract.mjs";
import { withPlatformContext } from "../lib/platform/context.mjs";
import { readRaw } from "../lib/platform/store.mjs";
import { act } from "../lib/platform/domain.mjs";
import { saveModelKey, MODEL } from "../lib/platform/model-config.mjs";
import { reserveModelBudget } from "../lib/platform/research.mjs";

const sourceText = "Synthetic Parts Ltd standalone report. USD thousands. As of 2026-09-30; period 2026-01-01 to 2026-09-30.\nCurrent assets 1,200\nCurrent liabilities 800\nOperating cash flow (100)\nNet income 80";
const source = { companyId: "c1", sourceText, sourceName: "Synthetic statement fixture", sourcePage: "p. 4", sourceUrl: "", authorized: true, dataClass: "real", reviewer: "Test reviewer",
  report: { entityName: "Synthetic Parts Ltd", entityRelation: "customer", scope: "standalone", balanceDate: "2026-09-30", periodStart: "2026-01-01", periodEnd: "2026-09-30", currency: "USD", scale: "1000", currentAssets: "1,200", currentLiabilities: "800", operatingCashFlow: "(100)", netIncome: "80" }, confirmations: { identity: true, basis: true } };
const company = { id: "c1", name: "Synthetic Parts Ltd" };
const output = (fields, unknowns = []) => JSON.stringify({ fields, unknowns });
const row = (field, value, quote, basisQuote) => ({ field, value, quote, ...(basisQuote ? { basisQuote } : {}) });
const basis = "As of 2026-09-30";

test("同口径四数确定公式：1.5倍、营运资本400000USD，现金流负不等同亏损或无付款能力", () => {
  const result = calculateFinancialReview(source, company);
  assert.equal(result.status, "reviewed"); assert.equal(result.metrics.currentRatio.value, "1.5");
  assert.equal(result.metrics.workingCapital.value, "400"); assert.equal(result.metrics.workingCapital.baseValue, "400000");
  assert.equal(result.metrics.operatingCashFlow.baseValue, "-100000"); assert.equal(result.metrics.netIncome.baseValue, "80000");
  assert.ok(result.warnings.some(w => w.includes("两者含义不同"))); assert.equal(result.appliesToCustomer, true);
  const decimal = calculateFinancialReview({ ...source, report: { ...source.report, currentAssets: "0.3", currentLiabilities: "0.2", scale: "1" } }, company);
  assert.equal(decimal.metrics.currentRatio.value, "1.5"); assert.equal(decimal.metrics.workingCapital.baseValue, "0.1");
});
test("缺失不当零，CL为零无Infinity；未确认口径不计算", () => {
  const missing = calculateFinancialReview({ ...source, report: { ...source.report, currentLiabilities: "", operatingCashFlow: "—" } }, company);
  assert.equal(missing.status, "incomplete"); assert.equal(missing.metrics.currentRatio.value, null); assert.equal(missing.metrics.operatingCashFlow.value, null);
  const zero = calculateFinancialReview({ ...source, report: { ...source.report, currentLiabilities: "0" } }, company);
  assert.equal(zero.metrics.currentRatio.status, "zero_denominator"); assert.equal(zero.metrics.currentRatio.value, null);
  assert.equal(zero.metrics.workingCapital.baseValue, "1200000"); assert.equal(JSON.stringify(zero).includes("Infinity"), true); // Only explicit warning text, never a value.
  const unconfirmed = calculateFinancialReview({ ...source, confirmations: { identity: true, basis: false } }, company);
  assert.equal(unconfirmed.metrics.currentRatio.status, "unconfirmed"); assert.equal(unconfirmed.metrics.workingCapital.value, null);
});
test("负资产负债拒绝，负现金流和负净利润原样核验；不接科学计数或歧义金额", () => {
  for (const key of ["currentAssets", "currentLiabilities"]) assert.throws(() => calculateFinancialReview({ ...source, report: { ...source.report, [key]: "(10)" } }, company), e => e.code === "FINANCIAL_NEGATIVE_BALANCE");
  const losses = calculateFinancialReview({ ...source, report: { ...source.report, operatingCashFlow: "−120.5", netIncome: "(20)" } }, company);
  assert.equal(losses.report.operatingCashFlow, "-120.5"); assert.equal(losses.report.netIncome, "-20");
  for (const value of ["1e3", "1.200,00", "$120", "1 200"]) assert.throws(() => calculateFinancialReview({ ...source, report: { ...source.report, currentAssets: value } }, company), e => e.code === "FINANCIAL_NUMBER_INVALID");
});
test("日期币种单位必须明确；未来日期不能当历史财报", () => {
  for (const patch of [{ currency: "$" }, { currency: "ZZZ" }, { scale: "1e6" }, { balanceDate: "2026-02-30" }, { periodStart: "2026-10-01" }, { periodEnd: "2026-08-31" }]) assert.throws(() => calculateFinancialReview({ ...source, report: { ...source.report, ...patch } }, company));
  const unknownCurrency = calculateFinancialReview({ ...source, report: { ...source.report, currency: "" } }, company); assert.equal(unknownCurrency.metrics.currentRatio.value, null);
  const future = calculateFinancialReview({ ...source, report: { ...source.report, balanceDate: "2099-12-31", periodEnd: "2099-12-31" } }, company);
  assert.equal(future.status, "incomplete"); assert.ok(future.missing.some(m => m.includes("未来")));
});
test("集团合并数据只归属报表范围，不作客户子公司/单体证据", () => {
  const grouped = calculateFinancialReview({ ...source, report: { ...source.report, entityName: "Synthetic Parent Group", entityRelation: "parent_group", scope: "consolidated" } }, company);
  assert.equal(grouped.metrics.currentRatio.value, "1.5"); assert.equal(grouped.appliesToCustomer, false); assert.ok(grouped.warnings.some(w => w.includes("子公司")));
  const unknown = calculateFinancialReview({ ...source, report: { ...source.report, scope: "unknown" } }, company);
  assert.equal(unknown.metrics.currentRatio.value, null);
});
test("AI只保留可核对引用：伪引用/非流动资产/丢负号/猜USD/信用分拒绝", () => {
  const good = validateFinancialExtraction(output([row("currentAssets", "1,200", "Current assets 1,200", basis), row("operatingCashFlow", "(100)", "Operating cash flow (100)", basis)]), sourceText);
  assert.equal(good.fields.length, 2); assert.equal(good.fields[1].value, "(100)");
  assert.throws(() => validateFinancialExtraction(output([row("currentAssets", "999", "Current assets 999", basis)]), sourceText), e => e.code === "FINANCIAL_EXTRACT_QUOTE");
  assert.throws(() => validateFinancialExtraction(output([row("currentAssets", "120", "Non-current assets 120", basis)]), basis + "\nNon-current assets 120"), e => e.code === "FINANCIAL_EXTRACT_VALUE");
  for (const value of ["(120)", "−120", "-120"]) assert.throws(() => validateFinancialExtraction(output([row("netIncome", "120", "Net income " + value, basis)]), basis + "\nNet income " + value), e => e.code === "FINANCIAL_EXTRACT_VALUE");
  assert.throws(() => validateFinancialExtraction(output([row("currency", "USD", "Amounts in $")]), "Amounts in $"), e => e.code === "FINANCIAL_EXTRACT_VALUE");
  assert.throws(() => validateFinancialExtraction(output([row("creditScore", "90", "Score 90")]), "Score 90"), e => e.code === "FINANCIAL_EXTRACT_SCHEMA");
  const metadataSource = "Report published on 2026-04-01.\nCurrent assets 1000";
  const metadata = validateFinancialExtraction(output([row("scale", "1000", "Current assets 1000"), row("balanceDate", "2026-04-01", "Report published on 2026-04-01.")]), metadataSource);
  assert.equal(metadata.fields.length, 0); assert.ok(metadata.unknowns.some(x => x.startsWith("scale"))); assert.ok(metadata.unknowns.some(x => x.startsWith("balanceDate")));
});
test("多年度表格或重复指标期间不明时不选列，basisQuote不能与别期金额拼接", () => {
  const table = "2025 | 2024\nCurrent assets | 200 | 100";
  const result = validateFinancialExtraction(output([row("currentAssets", "100", "Current assets | 200 | 100", "2025 | 2024")]), table);
  assert.equal(result.fields.length, 0); assert.ok(result.unknowns[0].includes("比较列"));
  const multiline = "Standalone report for 2025\nCurrent assets 200\nComparative report for 2024\nCurrent assets 100";
  const mismatched = validateFinancialExtraction(output([row("currentAssets", "100", "Current assets 100", "Standalone report for 2025")]), multiline);
  assert.equal(mismatched.fields.length, 0);
  const clipped = validateFinancialExtraction(output([row("currentAssets", "200", "Current assets | 200", "2025 | 2024")]), table);
  assert.equal(clipped.fields.length, 0);
});
async function database() {
  const sql = new DatabaseSync(":memory:");
  for (const file of (await readdir(new URL("../drizzle/", import.meta.url))).filter(f => f.endsWith(".sql")).sort()) sql.exec(await readFile(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  return { raw: sql, prepare(query) { return { bind(...values) { return { async first() { return sql.prepare(query).get(...values) || null; }, async run() { return { meta: { changes: Number(sql.prepare(query).run(...values).changes) } }; } }; } }; } };
}
const secret = Buffer.alloc(32, 7).toString("base64url");
const ctx = (db, ownerId = "u:finance-test") => ({ db, ownerId, authenticated: true, dataKey: secret });
async function withCompany() { const state = await act("create_company", { name: "Synthetic Parts Ltd", grade: "A", buyerRole: "人工原角色", nextAction: "人工安排" }); return { ...source, companyId: state.companies[0].id }; }
test("保存服务端重算hash，原文变动拒旧结果；去重、主体范围、来源留存且不改客户", async () => {
  const db = await database();
  try {
    await withPlatformContext(ctx(db), async () => {
      const payload = await withCompany(), before = structuredClone((await readRaw()).state.companies[0]);
      const grouped = { ...payload, report: { ...payload.report, entityName: "Synthetic Parent Group", scope: "consolidated", entityRelation: "parent_group" } };
      const preview = await reviewFinancialReport(grouped), beforeRead = JSON.stringify(await readRaw()); await reviewFinancialReport(grouped); assert.equal(JSON.stringify(await readRaw()), beforeRead);
      await assert.rejects(() => saveFinancialReview({ ...grouped, sourceText: sourceText + "\nChanged source.", reviewHash: preview.reviewHash }), e => e.code === "FINANCIAL_REVIEW_CHANGED");
      const saved = await saveFinancialReview({ ...grouped, reviewHash: preview.reviewHash }), repeated = await saveFinancialReview({ ...grouped, reviewHash: preview.reviewHash });
      assert.equal(repeated.meta.id, saved.meta.id); assert.equal(repeated.meta.duplicate, true);
      const state = (await readRaw()).state, record = state.financialReviews[0];
      assert.equal(record.report.scope, "consolidated"); assert.equal(record.sourceText, sourceText); assert.equal(record.sourcePage, "p. 4"); assert.equal(record.reviewer, "Test reviewer");
      assert.deepEqual(state.companies[0], before);
      await assert.rejects(() => reviewFinancialReport({ ...payload, dataClass: "synthetic" }), e => e.code === "DATA_CLASS_MISMATCH");
    });
    assert.equal(((await withPlatformContext(ctx(db, "u:other"), readRaw)).state.financialReviews || []).length, 0);
  } finally { db.raw.close(); }
});
test("没有模型配置清晰不可用，未调用网络、未扣预算、无固定财务返回", async () => {
  const db = await database(), originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Unexpected external call"); };
  try {
    await withPlatformContext(ctx(db), async () => {
      const payload = await withCompany();
      await assert.rejects(() => extractFinancialReport(payload), e => e.code === "MODEL_NOT_CONFIGURED");
      assert.equal((await readRaw()).state.runLog.length, 0); assert.equal(((await readRaw()).state.financialReviews || []).length, 0);
    });
  } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});
test("配置后的提取走单次SDK请求并记usage/requestID/sourceHash，保留调用计数但不设每日次数上限", async () => {
  const db = await database(), originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++; const body = JSON.parse(options.body); assert.equal(body.model, MODEL); assert.equal(body.stream, false); assert.equal(body.max_tokens, 1800);
    return new Response(JSON.stringify({ id: "synthetic-provider-response", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: output([row("currentAssets", "1,200", "Current assets 1,200", basis)]) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }), { status: 200, headers: { "Content-Type": "application/json", "x-request-id": "synthetic-request-id" } });
  };
  try {
    await withPlatformContext(ctx(db), async () => {
      const payload = await withCompany(); await saveModelKey("synthetic-financial-unit-test-key");
      for (let n = 0; n < 9; n++) await reserveModelBudget(payload.companyId, "synthetic-reserved-" + n, "fixture");
      const result = await extractFinancialReport(payload);
      assert.equal(calls, 1); assert.equal(result.result.status, "pending_review"); assert.equal(result.result.sourceHash, financialSourceHash(sourceText)); assert.equal(result.result.usage.totalTokens, 130);
      const log = (await readRaw()).state.runLog.find(r => r.purpose === "financial");
      assert.equal(log.requestId, "synthetic-request-id"); assert.equal(log.sourceHash, financialSourceHash(sourceText)); assert.equal(log.status, "validated_pending_review");
      assert.equal(((await readRaw()).state.financialReviews || []).length, 0);
      await extractFinancialReport(payload); assert.equal(calls, 2);
      assert.equal((await readRaw()).state.runLog.filter(r => r.type === "model_call").length, 11);
    });
  } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});
