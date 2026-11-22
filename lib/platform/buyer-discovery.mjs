import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { readPlatform, mutatePlatform } from "./store.mjs";
import { PlatformError, appendEvent, sameCompany } from "./domain.mjs";
import { validatePublicUrl, fetchPublicPage, pageEvidence, htmlToText, publicContacts } from "./web.mjs";
import { assessProductMatch, hasBuyerRoleEvidence } from "./screening.mjs";
import { assessCompanyHs } from "./customs-catalog.mjs";
import { getSearchConnection } from "./search-config.mjs";

export const DISCOVERY_PROVIDER = "Tavily Search · 独立 Key";
export const DISCOVERY_LIMITS = Object.freeze({ queries: 2, resultsPerQuery: 10, inspectPerRun: 3, pagesPerCandidate: 3, runsPerDay: 6, cacheHours: 6 });
export const DISCOVERY_RULE_VERSION = "buyer-evidence-v2-sentences";
const PROVIDER_URL = "https://api.tavily.com/search";
const categoryNames = { brake_lining: "brake lining", disc_brake_pad: "disc brake pad", brake_shoe: "brake shoe" };
const categoryPatterns = { brake_lining: /\b(?:brake|friction) linings?\b|鼓式刹车片|制动衬片|刹车衬片/i, disc_brake_pad: /\b(?:disc[- ]?)?brake pads?\b|\bdisc pads?\b|盘式刹车片|盘式制动片/i, brake_shoe: /\bbrake shoes?\b|制动蹄|刹车蹄/i };
const categories = Object.keys(categoryNames);
const roleNames = { importer: "importer", distributor: "distributor", wholesaler: "wholesaler" };
const trim = (value, limit = 1000) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, message, status = 400) => { throw new PlatformError(code, message, status); };
const criteriaSchema = z.object({
  productId: z.string().trim().max(160),
  category: z.enum(["brake_lining", "disc_brake_pad", "brake_shoe"]),
  targetMarket: z.string().trim().max(100),
  buyerRoles: z.array(z.enum(["importer", "distributor", "wholesaler"])).min(1).max(3),
  extraTerms: z.string().trim().max(120),
  excludedTerms: z.string().trim().max(120),
  hsCode: z.string().trim().max(40).default(""),
  hsCategoryConfirmed: z.boolean().default(false),
}).strict();
const notice = "本轮用真实公开搜索和规则核验，不调用语言模型。网站经营相关产品不证明当前采购需求、付款能力、竞争关系或配件适配；目标市场只是检索条件。";
const unknowns = ["企业名称与官网归属需人工确认", "实际采购负责人及当前采购计划未知", "付款能力未验证", "具体车型、车桥、尺寸和标准适配未确认", "目标市场仅用于搜索，企业所在地和服务地区尚未确认"];
function safeDomain(value) {
  try { return validatePublicUrl(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}
function companyDomain(company) {
  try { return new URL(company.website).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}
function selectedProduct(state, criteria) {
  if (!criteria.productId) return { id: "category:" + criteria.category, name: categoryNames[criteria.category], category: criteria.category, codes: [] };
  const product = state.products.find(item => item.id === criteria.productId);
  if (!product) fail("DISCOVERY_PRODUCT_NOT_FOUND", "所选产品已不存在，请重新选择产品。", 409);
  if (product.category !== criteria.category) fail("DISCOVERY_CATEGORY_MISMATCH", "所选产品与制动品类不一致，请重新预览搜索条件。", 409);
  return { id: product.id, name: product.name, category: product.category, codes: product.codes || [] };
}
function defaultsFor(seed, state) {
  const productIds = (seed.researchProductMatches || []).map(item => item.productId);
  const references = (seed.productRefs || []).join(" ");
  const product = state.products.find(item => categories.includes(item.category) && productIds.includes(item.id))
    || state.products.find(item => categories.includes(item.category) && item.codes?.some(code => ["WVA", "OE"].includes(code.namespace) && references.includes(code.value)));
  return { productId: product?.id || "", category: product?.category || "brake_lining", targetMarket: "", buyerRoles: ["importer", "distributor"], extraTerms: "", excludedTerms: "", hsCode: "", hsCategoryConfirmed: false };
}
function publicSearchWords(value) {
  // Plain, user-reviewed terms only. Never read chat, finance or contacts into a search query.
  return value.replace(/[\r\n\t]/g, " ").replace(/["<>`{}\\]/g, " ").replace(/\s+/g, " ").trim();
}
export function discoveryQueries(criteria, product) {
  const market = publicSearchWords(criteria.targetMarket), extra = publicSearchWords(criteria.extraTerms);
  const role = criteria.buyerRoles.map(key => roleNames[key]).join(" OR ");
  const exclude = criteria.excludedTerms.split(/[,，;；\n]+/).map(publicSearchWords).filter(Boolean).slice(0, 4).map(word => '-"' + word + '"').join(" ");
  const suffix = [market, extra, exclude].filter(Boolean).join(" ");
  const code = (product.codes || []).find(item => ["WVA", "OE"].includes(item.namespace) && /^[A-Za-z0-9 ./-]{2,40}$/.test(item.value));
  const hs = assessCompanyHs(criteria.hsCode);
  const queries = [trim('"' + categoryNames[criteria.category] + '" (truck OR trailer OR "commercial vehicle") (' + role + ") " + suffix, 500)];
  queries.push(trim((hs.hs6 ? '"HS ' + hs.hs6 + '" "' + categoryNames[criteria.category] + '"' : code ? '"' + code.namespace + ' ' + code.value + '" ' + categoryNames[criteria.category] : '"heavy duty" "' + categoryNames[criteria.category] + '"') + " (" + role + ") " + suffix, 500));
  return [...new Set(queries)];
}
async function buildPlan(payload) {
  const seedId = z.string().min(1).max(160).parse(payload.seedCompanyId);
  const state = await readPlatform();
  const seed = state.companies.find(item => item.id === seedId);
  if (!seed) fail("DISCOVERY_SEED_NOT_FOUND", "找不到作为参考的客户，请刷新客户列表。", 404);
  const criteria = criteriaSchema.parse(payload.criteria ?? defaultsFor(seed, state));
  criteria.buyerRoles = [...new Set(criteria.buyerRoles)].sort();
  const hsAssessment = assessCompanyHs(criteria.hsCode);
  if (!hsAssessment.formatValid) fail("DISCOVERY_HS_FORMAT", "请核对 HS 原码。网页找客只接受 6、8 或 10 位数字（可带点或空格），不会补零或恢复科学计数法。");
  if (hsAssessment.options.length && hsAssessment.options.every(item => !item.supported)) fail("DISCOVERY_HS_UNSUPPORTED", "该企业原码指向离合器面片；本轮只支持三类制动件，请不要将其转成刹车片搜索。");
  if (hsAssessment.options.length && !hsAssessment.options.some(item => item.category === criteria.category)) fail("DISCOVERY_HS_CATEGORY_MISMATCH", "所选品类与企业 HS 参考范围不一致，请核对原码后重新选择品类。", 409);
  if (hsAssessment.ambiguous && !criteria.hsCategoryConfirmed) fail("DISCOVERY_HS_CATEGORY_REQUIRED", "该 HS 范围对应多个品类，请手动选择本轮品类后再预览。", 409);
  const product = selectedProduct(state, criteria);
  const queries = discoveryQueries(criteria, product);
  const fingerprint = { seedCompanyId: seed.id, seedRevision: seed.revision || 0, criteria, product, queries };
  const planHash = hash(fingerprint);
  const seedHints = ["参考客户：" + seed.name];
  if (seed.productRefs?.length) seedHints.push("已录入产品参考（仍需核对）：" + seed.productRefs.slice(0, 5).join("、"));
  if (seed.market) seedHints.push("已录入市场：" + seed.market + "；请自行确认是否作为本轮目标市场。");
  const warnings = ["只提交下方公开产品与市场搜索词；不发送参考客户聊天、联系人、财报或内部备注。", "搜索结果中的公司名称和购买角色仍需官网与人工核验。"];
  const customsRecords = (state.customsRecords || []).filter(record => record.companyId === seed.id);
  const customsHints = customsRecords.slice(-20).reverse().map(record => ({ id: String(record.id || hash([record.sourceName, record.row, record.hsCode])), sourceName: trim(record.sourceName, 200), sourceRow: Number.isInteger(record.row) ? record.row : null,
    hsCode: String(record.hsCode || "").slice(0, 100), description: String(record.description || "").slice(0, 1200), country: String(record.country || "").slice(0, 100), dataClass: record.dataClass === "synthetic" ? "synthetic" : "real", hsAssessment: assessCompanyHs(record.hsCode) }));
  if (customsRecords.length > customsHints.length) warnings.push("当前展示最近 20 条关联海关来源，共 " + customsRecords.length + " 条；完整原始记录仍保存在海关导入资料中。");
  if (criteria.hsCode) warnings.push(...hsAssessment.warnings, "本轮用 HS6 补充搜索公开网页，不查询海关数据库；另一条查询不强制含 HS，以免漏掉不写海关码的企业官网。");
  if (!criteria.productId) warnings.push("本轮按所选制动品类搜索；未把默认品类当作该客户已确认的经营事实。");
  if (seed.isDemo || seed.dataClass === "synthetic" || seed.sourceKind === "seed") warnings.push("参考客户为来源案例/演示记录；本轮搜索返回独立的公开真实候选，不继承示例交易事实。");
  return { state, seed, product, plan: { seedCompanyId: seed.id, seedName: seed.name, criteria, queries, planHash, seedHints, customsHints, customsHintCount: customsRecords.length, hsAssessment, warnings, limits: DISCOVERY_LIMITS } };
}
export async function planBuyerDiscovery(payload) { return (await buildPlan(payload)).plan; }

async function readLimitedJson(response, limit = 600000) {
  const reader = response.body?.getReader();
  if (!reader) fail("SEARCH_EMPTY_RESPONSE", "搜索服务没有返回可读结果。", 502);
  const chunks = []; let length = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); fail("SEARCH_RESPONSE_TOO_LARGE", "搜索服务返回内容超过本轮上限。", 502); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail("SEARCH_INVALID_RESPONSE", "搜索服务未返回合法结果，未使用替代名单。", 502); }
}
const providerErrorCodes = new Set(["daily_cap_reached", "rate_limit_exceeded", "rate_limit_reached", "usage_limit_exceeded", "quota_exceeded", "insufficient_credits", "invalid_api_key", "missing_api_key", "unauthorized", "forbidden", "invalid_request", "invalid_request_error", "bad_request", "internal_server_error", "service_unavailable"]);
function diagnosticText(value, max = 400, secrets = []) {
  if (typeof value !== "string") return undefined;
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
  text = text.replace(/(?:tvly-|sk-)[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:api[_ -]?key|access[_ -]?token|authorization|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]")
    .replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}
function diagnosticRequestId(value, secrets = []) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value) || /(?:tvly-|sk-)/i.test(value) || secrets.some(secret => secret && value.includes(secret))) return undefined;
  return value;
}
function responseMetadata(response, secrets = []) {
  const result = { httpStatus: response.status };
  const requestId = diagnosticRequestId(response.headers.get("x-request-id") || response.headers.get("request-id"), secrets);
  if (requestId) result.requestId = requestId;
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter && /^\d{1,10}$/.test(retryAfter)) { result.retryAfter = retryAfter; result.retryAfterSeconds = Number(retryAfter); }
  else if (retryAfter && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter) && Number.isFinite(Date.parse(retryAfter))) {
    result.retryAfter = retryAfter; result.retryAfterSeconds = Math.max(0, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000));
  }
  return result;
}
async function searchErrorMetadata(response, secrets) {
  const result = responseMetadata(response, secrets); let data;
  // Never retain raw/HTML error bodies. Incomplete or >8 KiB JSON leaves headers only.
  try { data = await readLimitedJson(response, 8192); } catch { return result; }
  const error = data && typeof data === "object" ? data.error : null, detail = data?.detail;
  const code = typeof error?.code === "string" ? error.code : typeof detail?.code === "string" ? detail.code : data?.code;
  if (typeof code === "string" && providerErrorCodes.has(code.toLowerCase())) result.providerCode = code.toLowerCase();
  const message = diagnosticText(typeof error === "string" ? error : error?.message ?? (typeof detail === "string" ? detail : detail?.message ?? (typeof detail?.error === "string" ? detail.error : undefined)) ?? data?.message, 400, secrets);
  if (message) result.providerMessage = message;
  const requestId = diagnosticRequestId(data?.request_id, secrets); if (requestId) result.requestId = requestId;
  return result;
}
export function searchFailureMetadata(error) {
  const source = error?.searchDiagnostics || {}, result = {};
  for (const key of ["httpStatus", "durationMs", "retryAfterSeconds"]) if (typeof source[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0) result[key] = source[key];
  for (const key of ["requestId", "providerCode", "providerMessage", "retryAfter"]) if (typeof source[key] === "string") result[key] = source[key];
  return result;
}
export async function searchPublicCandidates(query, options = {}) {
  const apiKey = options.apiKey || null, maxResults = options.maxResults ?? DISCOVERY_LIMITS.resultsPerQuery;
  if (!apiKey) fail("SEARCH_NOT_CONFIGURED", "请先配置独立的 Tavily 搜索 Key；未发送请求。可以保留搜索条件，手工导入或提供企业官网继续核验。", 409);
  if (apiKey !== null && (typeof apiKey !== "string" || !/^tvly-[A-Za-z0-9_-]{7,1019}$/.test(apiKey))) fail("SEARCH_INVALID_KEY", "Tavily 搜索 Key 格式不正确；未发送请求。");
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > DISCOVERY_LIMITS.resultsPerQuery) fail("SEARCH_INVALID_LIMIT", "搜索返回数量超出本轮允许范围；未发送请求。");
  const started = performance.now(), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  let diagnostics = {};
  try {
    const response = await fetch(PROVIDER_URL, {
      // Workers supports manual/follow only; reject 3xx below without following it.
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ query, search_depth: "basic", topic: "general", max_results: maxResults, include_answer: false, include_raw_content: false, include_images: false, auto_parameters: false, include_usage: true }),
    });
    diagnostics = responseMetadata(response, [apiKey]);
    if (!response.ok) {
      diagnostics = await searchErrorMetadata(response, [apiKey]);
      const wait = diagnostics.retryAfterSeconds === undefined ? "" : "提供方建议等待至少 " + diagnostics.retryAfterSeconds + " 秒后再手动尝试，不保证届时已恢复。";
      const message = diagnostics.providerCode === "daily_cap_reached" ? "Tavily 明确返回每日免费 keyless 额度已达上限。" + wait + "可在设置中配置独立的 Tavily 搜索 Key；B1X 模型 Key 不通用。未自动重试。"
        : response.status === 429 ? "Tavily 返回 HTTP 429；尚不能确认是额度还是请求频率限制。" + wait + "未自动重试。"
        : "搜索服务返回 HTTP " + response.status + "，本次未取得该查询结果；未自动重试或切换认证方式。";
      fail(response.status === 429 ? "SEARCH_RATE_LIMIT" : [401, 403].includes(response.status) ? "SEARCH_AUTH_REJECTED" : "SEARCH_PROVIDER_ERROR", message, response.status === 429 ? 429 : 502);
    }
    const data = await readLimitedJson(response);
    if (!Array.isArray(data.results)) fail("SEARCH_INVALID_RESPONSE", "搜索响应缺少结果列表，不能当作零结果成功。", 502);
    if (data.results.some(item => !item || typeof item.url !== "string" || !item.url.trim() || (item.title !== undefined && typeof item.title !== "string") || (item.content !== undefined && typeof item.content !== "string"))) fail("SEARCH_INVALID_RESPONSE", "搜索服务返回了不完整的结果条目，不能当作零结果成功。", 502);
    const results = data.results.slice(0, maxResults).map(item => ({ title: trim(item.title, 240), url: item.url.slice(0, 2048), content: trim(item.content, 2000) }));
    const usage = typeof data.usage?.credits === "number" && Number.isFinite(data.usage.credits) && data.usage.credits >= 0 ? { credits: data.usage.credits } : undefined;
    return { results, httpStatus: response.status, durationMs: Math.round(performance.now() - started), requestId: diagnosticRequestId(data.request_id || response.headers.get("x-request-id"), [apiKey]) || "", usage };
  } catch (error) {
    const failure = error instanceof PlatformError ? error : new PlatformError(controller.signal.aborted ? "SEARCH_TIMEOUT" : "SEARCH_UNAVAILABLE", controller.signal.aborted ? "搜索请求超时，结果未知；没有自动重试或生成名单。" : "搜索服务当前无法连接；没有使用固定结果。", 502);
    failure.searchDiagnostics = { ...diagnostics, durationMs: Math.round(performance.now() - started) }; throw failure;
  } finally { clearTimeout(timer); }
}
function dayKey(value) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
export function assertPublicSearchAvailable(state, startedAt) {
  const runs = [...(state.discoveryRuns || []), ...(state.websiteResolutionRuns || [])].filter(run => run.sourceKind !== "manual_url");
  if (runs.some(run => run.status === "searching" && Date.now() - Date.parse(run.startedAt) < 60000)) fail("DISCOVERY_IN_PROGRESS", "当前工作区已有一轮公开搜索正在进行，请等待结果。", 409);
  if (runs.filter(run => dayKey(run.startedAt) === dayKey(startedAt)).length >= DISCOVERY_LIMITS.runsPerDay) fail("DISCOVERY_DAILY_LIMIT", "今天已用完 6 轮公开搜索预算（找买家与补官网合计）；已保存结果仍可核验。", 429);
}
export async function searchMoreBuyers(payload) {
  if (payload.confirmed !== true) fail("DISCOVERY_CONFIRM_REQUIRED", "请先核对下方公开搜索词，再确认开始搜索。");
  const { state: initial, seed, product, plan } = await buildPlan(payload);
  if (payload.planHash !== plan.planHash) fail("DISCOVERY_PLAN_CHANGED", "搜索条件、产品或参考客户已变化，请重新预览并确认。", 409);
  const inputHash = hash({ seedCompanyId: seed.id, criteria: plan.criteria, product, queries: plan.queries });
  const cached = (initial.discoveryRuns || []).find(run => run.inputHash === inputHash && run.status === "complete" && Date.now() - Date.parse(run.finishedAt || "") < DISCOVERY_LIMITS.cacheHours * 3600000);
  if (cached) return { state: initial, result: { run: cached, cached: true } };
  const connection = await getSearchConnection();
  const id = randomUUID(), startedAt = new Date().toISOString();
  await mutatePlatform(state => {
    state.discoveryRuns ||= [];
    if (state.discoveryRuns.some(run => run.inputHash === inputHash && run.status === "complete" && Date.now() - Date.parse(run.finishedAt || "") < 6 * 3600000)) fail("DISCOVERY_RECENT_RUN", "另一请求已完成相同搜索，请刷新读取已保存结果；没有重复调用。", 409);
    assertPublicSearchAvailable(state, startedAt);
    state.discoveryRuns.push({ id, seedCompanyId: seed.id, seedName: seed.name, criteria: plan.criteria, planHash: plan.planHash, inputHash, productSnapshot: product, provider: connection.authMode === "keyed" ? "Tavily Search · 账号 Key" : DISCOVERY_PROVIDER, authMode: connection.authMode, searchConfigSavedAt: connection.configSavedAt,
      status: "searching", startedAt, queries: plan.queries.map(query => ({ query, status: "pending", resultCount: 0 })), candidates: [],
      stats: { returned: 0, duplicateDomains: 0, seedMatches: 0, existingCompanies: 0, excluded: 0, newCandidates: 0 }, inspectionCount: 0, dataClass: "real", modelCalls: 0, notice });
  });
  const outcomes = await Promise.allSettled(plan.queries.map(query => searchPublicCandidates(query, { apiKey: connection.apiKey })));
  const state = await mutatePlatform(state => {
    const run = state.discoveryRuns.find(item => item.id === id);
    const byDomain = new Map(), existingDomains = new Set(state.companies.map(companyDomain).filter(Boolean)), seedDomain = companyDomain(seed);
    let successful = 0;
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "rejected") {
        const error = outcome.reason;
        Object.assign(run.queries[index], { status: "failed", errorCode: error.code || "SEARCH_FAILED", message: error.publicError ? error.message : "本查询未完成，没有生成替代结果。", ...searchFailureMetadata(error) });
        return;
      }
      successful++;
      const { results, ...meta } = outcome.value;
      Object.assign(run.queries[index], { status: "complete", resultCount: results.length, ...meta });
      run.stats.returned += results.length;
      for (const item of results) {
        const domain = safeDomain(item.url);
        if (!domain) { run.stats.excluded++; continue; }
        if (domain === seedDomain) { run.stats.seedMatches++; continue; }
        if (existingDomains.has(domain)) { run.stats.existingCompanies++; continue; }
        if (byDomain.has(domain)) { run.stats.duplicateDomains++; const previous = byDomain.get(domain); if (!previous.sourceQueryIndexes.includes(index)) previous.sourceQueryIndexes.push(index); continue; }
        const url = new URL(item.url); url.hash = "";
        const candidate = { id: randomUUID(), title: item.title || domain, url: url.href, domain, searchSnippet: item.content, sourceQueryIndexes: [index], discoveredAt: startedAt,
          status: "unverified", evidence: [], productEvidence: [], roleEvidence: [], contacts: [], unknowns: [...unknowns], warnings: ["目前仅为搜索摘要，尚未读取该企业官网。"], pagesFetched: 0,
          prescreen: prescreenDiscoveryCandidate(item.title + ". " + item.content, plan.criteria.category) };
        byDomain.set(domain, candidate);
      }
    });
    const priority = { first: 0, normal: 1, later: 2 };
    run.candidates = [...byDomain.values()].sort((a, b) => priority[a.prescreen.priority] - priority[b.prescreen.priority]); run.stats.newCandidates = run.candidates.length;
    run.status = successful === outcomes.length ? "complete" : successful ? "partial" : "failed";
    run.finishedAt = new Date().toISOString();
    appendEvent(state, seed.id, "buyer_discovery_searched", "按公开条件搜索新买家", { runId: id, summary: "公开搜索 " + successful + "/" + outcomes.length + " 条完成；发现 " + run.candidates.length + " 家未录入域名候选，未确认采购意向。" });
  });
  return { state, result: { run: state.discoveryRuns.find(run => run.id === id), cached: false } };
}

function getRun(state, runId) {
  const run = (state.discoveryRuns || []).find(item => item.id === runId);
  if (!run) fail("DISCOVERY_RUN_NOT_FOUND", "当前工作区没有这轮搜索，请从本工作区历史重新打开。", 404);
  return run;
}
function getCandidate(run, candidateId) {
  const candidate = run.candidates.find(item => item.id === candidateId);
  if (!candidate) fail("DISCOVERY_CANDIDATE_NOT_FOUND", "所选企业不在这轮真实搜索结果中。", 404);
  return candidate;
}
function sourceSentences(text) {
  return String(text || "").slice(0, 12000).split(/\n+|(?<=[.!?。！？])\s+(?=[A-Z\u4e00-\u9fff])/u).map(value => trim(value, 1200)).filter(value => value.length >= 8 && value.length <= 600);
}
function ownNamedSubject(subject, source) {
  const name = subject.trim();
  if (/^(?:we|our company|our business)$/i.test(name)) return true;
  // Accept a simple company-name subject, never a name mentioned inside a comparison,
  // ownership phrase or description of another business.
  if (!/^[a-z0-9][a-z0-9 &.\-]*$/i.test(name) || /\b(?:unlike|like|versus|vs|next|near|beside|behind|opposite|to|for|from|with|without|whose|which|that|their|our|its|his|her|your|partner|supplier|customer|client)\b/i.test(name)) return false;
  let host = ""; try { host = new URL(source.url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return false; }
  const first = name.replace(/^the\s+/i, "").toLowerCase().split(/[^a-z0-9]+/)[0];
  if (!first || ["limited", "company", "group", "international", "business", "manufacturer", "supplier", "partner", "customer"].includes(first)) return false;
  return host.split(/[.-]/).some(part => part === first || first.length >= 5 && part.startsWith(first));
}
function ownRoleSentence(quote, source) {
  if (/\b(?:not|never|no longer|formerly|former|previously|ceased|stopped)\b|不再|不是|并非|曾经|以前/i.test(quote)) return false;
  if (/\b(?:become|join|apply|find|looking for|seeking|recruit|recruiting|wanted)\b[^.!?]{0,100}\b(?:distributors?|dealers?|importers?|wholesalers?|network)\b|招募|寻找经销商|加盟|成为经销商/i.test(quote)) return false;
  if (/\b(?:our|their) (?:customers?|clients?|suppliers?|partners?)\b|\b(?:supply|sell|supplies|sells) to\b|客户是|供应给/i.test(quote)) return false;
  if (/\bwe (?:also |directly )?(?:import|distribute|wholesale|purchase|buy)\b|我们(?:进口|采购)|我司(?:进口|采购)/i.test(quote)) return true;
  if (/\b(?:we are|we['’]re|we operate as|our company is|our business is)\s+(?:(?:now|currently|also)\s+){0,2}(?:an? |the )?(?:(?:leading|independent|specialist|authorized|authorised|official|approved|exclusive|regional|international|major|trusted|wholesale|industrial|automotive|parts|truck)[ -]){0,6}(?:importers?|distributors?|wholesalers?)\b|(?:我们|我司|本公司)是.{0,20}(?:进口商|经销商|分销商|批发商)/i.test(quote)) return true;
  const named = /^(.{2,90}?)\s+(?:is|are|(?:has|have)\s+(?:(?:recently|now|officially)\s+)?been|was)\s+(?:(?:recently|officially)\s+)?(?:(?:appointed|selected|named|designated|authori[sz]ed)\s+(?:as\s+)?)?(?:an? |the )?(?:(?:UK|US|European|leading|independent|specialist|authorized|authorised|exclusive|regional|international|major|trusted|wholesale|official)[ -]){0,6}(?:importer|distributor|wholesaler)\b/i.exec(quote);
  return !!named && ownNamedSubject(named[1], source);
}
export function prescreenDiscoveryCandidate(text, category) {
  const product = categoryPatterns[category]?.test(text) && /\btruck|trailer|commercial vehicle|heavy duty|商用车|卡车|挂车/i.test(text);
  const role = /\bimporter|distributor|wholesaler|进口商|分销商|经销商|批发商/i.test(text);
  return { priority: product && role ? "first" : product ? "normal" : "later", basis: "search_snippet", reasons: [...(product ? ["摘要出现商用车与目标制动品类词"] : ["摘要未同时说明商用车和目标品类"]), ...(role ? ["摘要出现进口/分销/批发词，自身角色仍待官网确认"] : ["摘要尚无采购渠道角色线索"]), "仅决定先核验谁，不确认买家身份或提高客户分级"] };
}
export function inspectDiscoveryEvidence(sources, product) {
  const productEvidence = [], roleEvidence = [], withheld = [];
  const categoryPattern = categoryPatterns[product.category];
  for (const source of sources) {
    const quotes = sourceSentences(source.snippet).filter(quote => categoryPattern.test(quote) || /\b(?:WVA|OE|OEM|reference|ref\.?|part|article)\b/i.test(quote));
    for (const quote of quotes) {
      for (const relationship of ["same_code", "related_category"]) {
        if (relationship === "same_code" && !product.codes.length) continue;
        const match = { productId: product.id, relationship, sourceId: source.id, quote };
        const assessment = assessProductMatch(match, product, sources);
        if (assessment.accepted && !productEvidence.some(item => item.sourceId === source.id && item.relationship === relationship)) productEvidence.push(match);
        else if (!assessment.accepted && /冲突|停产|否定|非商用|乘用车|年份|年款/.test(assessment.reason)) withheld.push(assessment.reason);
      }
    }
    for (const quote of sourceSentences(source.snippet).filter(quote => /\b(?:importers?|distributors?|wholesalers?|procurement|purchasing|we (?:also |directly )?(?:import|distribute|wholesale|purchase|buy))\b|进口商|经销商|分销商|批发商|进口业务|我们(?:进口|采购)|我司(?:进口|采购)/i.test(quote))) {
      const fact = { field: "buyer_role", sourceId: source.id, quote };
      if (ownRoleSentence(quote, source) && hasBuyerRoleEvidence([fact], sources) && !roleEvidence.some(item => item.sourceId === source.id)) roleEvidence.push(fact);
    }
  }
  return { productEvidence: productEvidence.slice(0, 4), roleEvidence: roleEvidence.slice(0, 2), withheld: [...new Set(withheld)].slice(0, 5) };
}
function inspectedHash(candidate) {
  const value = { id: candidate.id, url: candidate.url, evidence: candidate.evidence, productEvidence: candidate.productEvidence, roleEvidence: candidate.roleEvidence, inspectedAt: candidate.inspectedAt };
  if (candidate.inspectionRuleVersion) Object.assign(value, { contacts: candidate.contacts || [], inspectionRuleVersion: candidate.inspectionRuleVersion });
  return hash(value);
}
export function discoveryPageEvidence(page) {
  const main = page.html.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2] || page.html;
  const body = main.replace(/<(nav|header|footer|form|select)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  return pageEvidence({ ...page, text: htmlToText(body) });
}
function extraDiscoveryLinks(page) {
  const links = [], host = safeDomain(page.url);
  for (const match of page.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/gi, "&"), page.url); url.hash = "";
      if (safeDomain(url.href) !== host || url.href === page.url) continue;
      const text = htmlToText(match[2]) + " " + url.pathname;
      const kind = /contact|kontakt|yhteystiedot|contacto|联系我们/i.test(text) ? "contact" : /about|company|meista|关于/i.test(text) ? "about" : /brake|friction|product|catalog|产品|制动|刹车/i.test(text) ? "product" : "";
      if (kind && !links.some(link => link.url === url.href)) links.push({ url: url.href, kind });
    } catch { /* Only observed same-site public links are eligible. */ }
  }
  return links;
}
function uniqueContacts(contacts) {
  return [...new Map(contacts.map(contact => [contact.type + ":" + (contact.type === "phone" ? contact.value.replace(/\D/g, "") : contact.value.toLowerCase()), contact])).values()].slice(0, 30);
}
function applyRuleResult(candidate, result) {
  candidate.productEvidence = result.productEvidence; candidate.roleEvidence = result.roleEvidence;
  candidate.status = candidate.evidence.length ? result.productEvidence.length && result.roleEvidence.length ? "related_evidence" : "needs_evidence" : "blocked";
  candidate.unknowns = [...unknowns, ...(!result.productEvidence.length ? ["官网尚未提供通过核验的商用车具体制动品类或同编号依据"] : []), ...(!result.roleEvidence.length ? ["官网尚未提供该企业自身进口、分销或批发角色依据"] : []), ...(!(candidate.contacts || []).length ? ["尚未从已读取页面取得公开联系入口；不代表企业没有联系方式"] : [])];
  candidate.inspectionRuleVersion = DISCOVERY_RULE_VERSION;
}
export async function inspectBuyerCandidate(payload) {
  const { runId, candidateId } = z.object({ runId: z.string().max(160), candidateId: z.string().max(160) }).parse(payload);
  const initial = await readPlatform(), initialRun = getRun(initial, runId), target = getCandidate(initialRun, candidateId);
  if (target.inspectedAt && target.status !== "inspecting") return { state: initial, result: { run: initialRun, candidate: target, cached: true } };
  await mutatePlatform(state => {
    const run = getRun(state, runId), candidate = getCandidate(run, candidateId);
    if (candidate.status === "inspecting") fail("DISCOVERY_INSPECTING", "该候选正在核验，请稍后刷新。", 409);
    if (run.inspectionCount >= DISCOVERY_LIMITS.inspectPerRun) fail("DISCOVERY_INSPECT_LIMIT", "本轮已核验 3 家候选。先把时间用在已筛出的企业上。", 429);
    run.inspectionCount++; candidate.status = "inspecting";
  });
  const sources = [], warnings = [], urls = [], contacts = [];
  try {
    const first = await fetchPublicPage(target.url); urls.push(first.url); sources.push(discoveryPageEvidence(first)); contacts.push(...publicContacts(first));
    const links = extraDiscoveryLinks(first), visited = new Set([target.url, first.url]), visitedKinds = new Set();
    for (let slot = 1; slot < DISCOVERY_LIMITS.pagesPerCandidate; slot++) {
      const assessment = inspectDiscoveryEvidence(sources, initialRun.productSnapshot);
      const order = !assessment.productEvidence.length ? ["product", "about", "contact"] : !assessment.roleEvidence.length ? ["about", "contact", "product"] : ["contact", "about", "product"];
      const next = order.filter(kind => !visitedKinds.has(kind)).map(kind => links.find(link => link.kind === kind && !visited.has(link.url))).find(Boolean);
      if (!next) break;
      visited.add(next.url); visitedKinds.add(next.kind);
      try { const page = await fetchPublicPage(next.url); visited.add(page.url); if (!urls.includes(page.url)) { urls.push(page.url); sources.push(discoveryPageEvidence(page)); contacts.push(...publicContacts(page)); } for (const link of extraDiscoveryLinks(page)) if (!links.some(item => item.url === link.url)) links.push(link); }
      catch (error) { warnings.push(error.publicError ? "附加页：" + error.message : "附加页面未能读取。已保留成功读取的原文。"); }
    }
  } catch (error) { warnings.push(error.publicError ? error.message : "官网读取失败；搜索摘要未当作官网证据。"); }
  const evidenceResult = inspectDiscoveryEvidence(sources, initialRun.productSnapshot);
  const state = await mutatePlatform(state => {
    const run = getRun(state, runId), candidate = getCandidate(run, candidateId);
    candidate.evidence = sources;
    candidate.contacts = uniqueContacts(contacts);
    candidate.pagesFetched = sources.length; candidate.inspectedAt = new Date().toISOString();
    applyRuleResult(candidate, evidenceResult);
    candidate.warnings = [...warnings, ...evidenceResult.withheld];
    if (urls.some(url => safeDomain(url) !== candidate.domain)) candidate.warnings.push("页面跳转到另一域名，请人工确认它与搜索候选是否为同一企业。");
    candidate.candidateHash = inspectedHash(candidate);
    appendEvent(state, run.seedCompanyId, "buyer_candidate_inspected", "核验候选企业公开网页", { runId, candidateId, summary: "读取 " + sources.length + " 页；产品和采购渠道角色按原文分别保留，当前采购需求未知。" });
  });
  const run = getRun(state, runId);
  return { state, result: { run, candidate: getCandidate(run, candidateId), cached: false } };
}
export async function reassessBuyerCandidate(payload) {
  const { runId, candidateId } = z.object({ runId: z.string().max(160), candidateId: z.string().max(160) }).parse(payload);
  const state = await mutatePlatform(state => {
    const run = getRun(state, runId), candidate = getCandidate(run, candidateId);
    if (!candidate.evidence?.length || candidate.status === "inspecting") fail("DISCOVERY_STORED_EVIDENCE_REQUIRED", "需要已经保存的官网原文，才能不联网重新核对。", 409);
    const result = inspectDiscoveryEvidence(candidate.evidence, run.productSnapshot);
    candidate.contacts = candidate.contacts || [];
    applyRuleResult(candidate, result);
    candidate.warnings = [...new Set([...(candidate.warnings || []), ...result.withheld, "本次只重新核对已保存原文，没有读取新网页；旧记录缺少 HTML 时不补造联系方式。已保存客户资料不自动改写。"] )];
    candidate.candidateHash = inspectedHash(candidate);
    appendEvent(state, run.seedCompanyId, "buyer_candidate_reassessed", "重新核对已保存官网原文", { runId, candidateId, summary: "无网络请求、不消耗新企业核验额度；不自动改写已保存客户。" });
  });
  const run = getRun(state, runId);
  return { state, result: { run, candidate: getCandidate(run, candidateId), cached: false } };
}
function makeDiscoveredCompany(candidate, run, name, now) {
  const supportedProduct = run.productSnapshot.id.startsWith("category:") ? [] : run.productSnapshot.codes.filter(code => ["WVA", "OE"].includes(code.namespace) && candidate.productEvidence.some(match => match.relationship === "same_code" && assessProductMatch(match, { ...run.productSnapshot, codes: [code] }, candidate.evidence).accepted)).map(code => code.namespace + " " + code.value);
  const website = candidate.evidence[0]?.url || candidate.url;
  return { id: randomUUID(), name, website, market: "", productRefs: supportedProduct,
    buyerRole: candidate.roleEvidence.length ? "官网存在进口/分销/批发角色原文，具体采购职责待确认" : "实际采购角色待核验",
    grade: "unknown", gradeSource: "unknown", stage: "待研究", owner: "", nextAction: "复核产品和采购角色，再寻找采购负责人", nextFollowUpAt: "",
    notes: "由公开搜索发现并人工确认官网归属。本轮目标市场：" + (run.criteria.targetMarket || "未限定") + "；这是搜索条件，不是已确认的企业所在地。",
    sourceUrl: candidate.url, sourceKind: "discovery", discoveryRunId: run.id, discoveryCandidateId: candidate.id,
    evidence: structuredClone(candidate.evidence), communications: [], contacts: uniqueContacts(structuredClone(candidate.contacts || [])), memoryProposals: [], memoryHistory: [], memoryByInquiry: {},
    researchStatus: "evidence_only", researchProductMatches: structuredClone(candidate.productEvidence.filter(item => !item.productId.startsWith("category:"))),
    websiteFacts: candidate.roleEvidence.map(item => ({ ...item, value: "官网自身经营角色线索；待人工确认采购职责", classification: "rule_quote_pending_review" })),
    missingEvidence: [...candidate.unknowns], revision: 1, createdAt: now, updatedAt: now, dataClass: "real", isDemo: false };
}
export async function saveBuyerCandidate(payload) {
  const input = z.object({ runId: z.string().min(1).max(160), candidateId: z.string().min(1).max(160), companyName: z.string().trim().min(1).max(160), confirmIdentity: z.literal(true), expectedCandidateHash: z.string().length(64) }).parse(payload);
  const result = { companyId: "", duplicate: false, runId: input.runId, candidateId: input.candidateId };
  const state = await mutatePlatform(state => {
    const run = getRun(state, input.runId), candidate = getCandidate(run, input.candidateId);
    if (!candidate.evidence.length || !candidate.inspectedAt || !["related_evidence", "needs_evidence"].includes(candidate.status)) fail("DISCOVERY_EVIDENCE_REQUIRED", "请先核验候选官网，确认原文后再保存客户。", 409);
    if (candidate.candidateHash !== input.expectedCandidateHash || inspectedHash(candidate) !== input.expectedCandidateHash) fail("DISCOVERY_CANDIDATE_CHANGED", "候选证据已变化，请重新查看并确认后保存。", 409);
    const previouslySaved = candidate.savedCompanyId && state.companies.find(item => item.id === candidate.savedCompanyId);
    if (previouslySaved) { result.companyId = previouslySaved.id; result.duplicate = true; return; }
    const company = makeDiscoveredCompany(candidate, run, input.companyName, new Date().toISOString());
    const existing = state.companies.find(item => sameCompany(item, company));
    if (existing) { result.companyId = existing.id; result.duplicate = true; candidate.savedCompanyId = existing.id; return; }
    state.companies.push(company); candidate.savedCompanyId = company.id; result.companyId = company.id;
    appendEvent(state, company.id, "buyer_candidate_saved", "人工确认并保存公开搜索候选", { runId: run.id, candidateId: candidate.id, summary: "保留官网原文；采购需求、付款能力和具体适配仍待核验，未自动提高等级。" });
  });
  return { state, result };
}
