import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { readPlatform, mutatePlatform } from "./store.mjs";
import { PlatformError, appendEvent, companyIdentity } from "./domain.mjs";
import { validatePublicUrl, fetchPublicPage, publicContacts, htmlToText } from "./web.mjs";
import { searchPublicCandidates, searchFailureMetadata, discoveryPageEvidence, assertPublicSearchAvailable, DISCOVERY_PROVIDER } from "./buyer-discovery.mjs";
import { getSearchConnection, searchConfigStatus } from "./search-config.mjs";

export const WEBSITE_LIMITS = Object.freeze({ queries: 2, resultsPerQuery: 10, inspectPerRun: 3, pagesPerCandidate: 2, runsPerDay: 6, cacheHours: 6 });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, message, status = 400) => { throw new PlatformError(code, message, status); };
const idSchema = z.string().min(1).max(160);
const criteriaSchema = z.object({ name: z.string().trim().min(2).max(160), country: z.string().trim().max(100) }).strict();
const notice = "Tavily 公开搜索，不调用语言模型。名称相同不代表同一企业；官网归属必须人工确认，联系人的岗位、采购需求和付款能力仍未知。";
const words = value => value.replace(/[\r\n\t"<>`{}\\]/g, " ").replace(/\s+/g, " ").trim();
const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function domain(value) { return validatePublicUrl(value).hostname.toLowerCase().replace(/^www\./, ""); }
function findCompany(state, id) {
  const company = state.companies.find(item => item.id === id);
  if (!company) fail("WEBSITE_COMPANY_NOT_FOUND", "当前工作区没有这家企业。", 404);
  return company;
}
function ensureEmpty(company) {
  if (company.website) fail("WEBSITE_ALREADY_PRESENT", "该企业已有网址；本流程只补空官网，替换网址请使用企业编辑并核对历史资料。", 409);
}
function runFor(state, id) {
  const run = (state.websiteResolutionRuns || []).find(item => item.id === id);
  if (!run) fail("WEBSITE_RUN_NOT_FOUND", "当前工作区没有这轮官网搜索。", 404);
  return run;
}
function candidateFor(run, id) {
  const candidate = run.candidates.find(item => item.id === id);
  if (!candidate) fail("WEBSITE_CANDIDATE_NOT_FOUND", "没有找到本轮候选，不能使用其他来源代替。", 404);
  return candidate;
}
function companyBasis(company) { return hash({ id: company.id, name: company.name, market: company.market || "", website: company.website || "", dataClass: company.dataClass || "real", revision: company.revision }); }
function currentCompany(state, run) {
  const company = findCompany(state, run.companyId);
  ensureEmpty(company);
  if (companyBasis(company) !== run.companyBasisHash) fail("WEBSITE_COMPANY_CHANGED", "企业资料已变化，请重新预览公司名称后搜索。", 409);
  return company;
}
async function buildPlan(payload) {
  const state = await readPlatform(), company = findCompany(state, idSchema.parse(payload.companyId));
  ensureEmpty(company);
  const criteria = criteriaSchema.parse(payload.criteria ?? { name: company.name, country: "" });
  criteria.name = words(criteria.name); criteria.country = words(criteria.country);
  if (criteria.name.length < 2) fail("WEBSITE_NAME_REQUIRED", "请填写可核对的企业名称。");
  const queries = ['"' + criteria.name + '" ' + criteria.country + " official website", '"' + criteria.name + '" ' + criteria.country + " company contact about"].map(value => value.replace(/\s+/g, " ").trim());
  const basis = companyBasis(company), planHash = hash({ companyId: company.id, basis, criteria, queries });
  const config = await searchConfigStatus();
  return { state, company, basis, plan: { companyId: company.id, companyName: company.name, expectedRevision: company.revision, criteria, queries, planHash, provider: config.configured ? "Tavily Search · 账号 Key" : DISCOVERY_PROVIDER,
    marketHint: company.market || "", limits: WEBSITE_LIMITS, warnings: ["只有下方公司名称与国家搜索词会发送给 Tavily；不会发送聊天、财报、海关货描或内部备注。", "国家是检索范围，不会自动改写企业所在地。同名、集团与子公司必须逐项人工核对。", ...(company.dataClass === "synthetic" || company.isDemo ? ["该客户为样例记录；公开搜索不会把样例交易或身份改成真实。"] : [])] } };
}
export async function planCompanyWebsite(payload) { return (await buildPlan(payload)).plan; }
export async function inspectCompanyWebsiteUrl(payload) {
  const input = z.object({ mode: z.literal("inspect_url").optional(), companyId: idSchema, criteria: criteriaSchema, url: z.string().trim().min(1).max(2048), expectedRevision: z.number().int().positive(), confirmed: z.literal(true) }).strict().parse(payload);
  const url = validatePublicUrl(input.url); url.hash = "";
  const { state: initial, company, basis, plan } = await buildPlan(input);
  if (input.expectedRevision !== company.revision) fail("REVISION_CONFLICT", "企业资料已变化，请刷新后核对名称和官网。", 409);
  const inputHash = hash({ sourceKind: "manual_url", companyId: company.id, basis, url: url.href, criteria: plan.criteria });
  const recent = item => item.sourceKind === "manual_url" && item.inputHash === inputHash && Date.now() - Date.parse(item.finishedAt || item.startedAt) < WEBSITE_LIMITS.cacheHours * 3600000;
  const cached = initial.websiteResolutionRuns.find(item => recent(item) && item.status === "complete" && item.candidates[0]?.inspectedAt);
  if (cached) return { state: initial, result: { run: cached, candidate: cached.candidates[0], cached: true } };
  const id = randomUUID(), candidateId = randomUUID(), startedAt = new Date().toISOString(); let reservedCacheId = "";
  const reserved = await mutatePlatform(state => {
    const live = findCompany(state, company.id); ensureEmpty(live);
    if (companyBasis(live) !== basis || input.expectedRevision !== live.revision) fail("WEBSITE_COMPANY_CHANGED", "企业资料刚刚更新，请重新核对后读取。", 409);
    const completed = state.websiteResolutionRuns.find(item => recent(item) && item.status === "complete" && item.candidates[0]?.inspectedAt);
    if (completed) { reservedCacheId = completed.id; return; }
    if (state.websiteResolutionRuns.some(item => recent(item) && item.status === "searching" && Date.now() - Date.parse(item.startedAt) < 60000)) fail("WEBSITE_INSPECTING", "同一网址正在读取，请等待当前请求；未重复读取。", 409);
    state.websiteResolutionRuns.push({ id, companyId: company.id, companyName: company.name, companyRevision: company.revision, companyBasisHash: basis,
      sourceKind: "manual_url", criteria: plan.criteria, planHash: inputHash, inputHash, provider: "用户提供官网", status: "searching", startedAt,
      queries: [], inspectionCount: 0, modelCalls: 0, stats: { returned: 0, excluded: 0, duplicateDomains: 0 },
      notice: "此网址由用户提供，仅直接读取公开网页核对身份和联系入口；未调用 Tavily 或其他搜索服务，不代表搜索成功，不消耗搜索轮次。",
      candidates: [{ id: candidateId, title: url.hostname, url: url.href, domain: domain(url.href), searchSnippet: "", sourceQueryIndexes: [], status: "unverified", evidence: [], identityEvidence: [], contacts: [], pagesFetched: 0, warnings: ["用户提供的网址尚未核对，不能直接认定为企业官网。"] }] });
    appendEvent(state, company.id, "company_website_url_provided", "提交公开官网进行原文核对", { runId: id, sourceKind: "manual_url", summary: "用户提供网址；未请求搜索服务。" });
  });
  if (reservedCacheId) { const run = runFor(reserved, reservedCacheId); return { state: reserved, result: { run, candidate: run.candidates[0], cached: true } }; }
  return inspectCompanyWebsite({ runId: id, candidateId });
}
export async function searchCompanyWebsite(payload) {
  if (payload.confirmed !== true) fail("WEBSITE_CONFIRM_REQUIRED", "请先核对搜索词并确认公开搜索。");
  const { state: initial, company, basis, plan } = await buildPlan(payload);
  if (payload.planHash !== plan.planHash) fail("WEBSITE_PLAN_CHANGED", "企业或搜索条件已变化，请重新预览并确认。", 409);
  const inputHash = hash({ companyId: company.id, basis, criteria: plan.criteria, queries: plan.queries });
  const cached = initial.websiteResolutionRuns.find(run => run.inputHash === inputHash && run.status === "complete" && Date.now() - Date.parse(run.finishedAt || "") < WEBSITE_LIMITS.cacheHours * 3600000);
  if (cached) return { state: initial, result: { run: cached, cached: true } };
  const connection = await getSearchConnection();
  const id = randomUUID(), startedAt = new Date().toISOString();
  await mutatePlatform(state => {
    const live = findCompany(state, company.id); ensureEmpty(live);
    if (companyBasis(live) !== basis) fail("WEBSITE_COMPANY_CHANGED", "企业资料刚刚更新，请重新预览。", 409);
    if (state.websiteResolutionRuns.some(run => run.inputHash === inputHash && run.status === "complete" && Date.now() - Date.parse(run.finishedAt || "") < 6 * 3600000)) fail("DISCOVERY_RECENT_RUN", "另一请求已完成相同搜索，请刷新读取已保存结果；没有重复调用。", 409);
    assertPublicSearchAvailable(state, startedAt);
    state.websiteResolutionRuns.push({ id, companyId: company.id, companyName: company.name, companyRevision: company.revision, companyBasisHash: basis,
      criteria: plan.criteria, planHash: plan.planHash, inputHash, provider: connection.authMode === "keyed" ? "Tavily Search · 账号 Key" : DISCOVERY_PROVIDER, authMode: connection.authMode, searchConfigSavedAt: connection.configSavedAt, status: "searching", startedAt,
      queries: plan.queries.map(query => ({ query, status: "pending", resultCount: 0 })), candidates: [], inspectionCount: 0, modelCalls: 0, notice,
      stats: { returned: 0, excluded: 0, duplicateDomains: 0 } });
  });
  const outcomes = await Promise.allSettled(plan.queries.map(query => searchPublicCandidates(query, { apiKey: connection.apiKey })));
  const state = await mutatePlatform(state => {
    const run = runFor(state, id), byDomain = new Map(); let successes = 0;
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "rejected") {
        const error = outcome.reason;
        Object.assign(run.queries[index], { status: "failed", errorCode: error.code || "SEARCH_FAILED", message: error.publicError ? error.message : "本查询未完成，没有生成替代官网。", ...searchFailureMetadata(error) }); return;
      }
      successes++; const { results, ...metadata } = outcome.value;
      Object.assign(run.queries[index], { status: "complete", resultCount: results.length, ...metadata }); run.stats.returned += results.length;
      for (const item of results) {
        let host, url;
        try { host = domain(item.url); url = validatePublicUrl(item.url); url.hash = ""; } catch { run.stats.excluded++; continue; }
        if (byDomain.has(host)) { run.stats.duplicateDomains++; const prior = byDomain.get(host); if (!prior.sourceQueryIndexes.includes(index)) prior.sourceQueryIndexes.push(index); continue; }
        const existing = state.companies.find(value => value.id !== company.id && value.website && companyIdentity(value) === host);
        byDomain.set(host, { id: randomUUID(), title: item.title || host, url: url.href, domain: host, searchSnippet: item.content, sourceQueryIndexes: [index],
          status: "unverified", evidence: [], identityEvidence: [], contacts: [], warnings: ["当前只有搜索摘要，尚未核对网站原文。", ...(existing ? ["该域名已由另一条客户记录使用；不能直接补入。"] : [])], pagesFetched: 0, ...(existing ? { existingCompanyId: existing.id } : {}) });
      }
    });
    run.candidates = [...byDomain.values()]; run.status = successes === outcomes.length ? "complete" : successes ? "partial" : "failed"; run.finishedAt = new Date().toISOString();
    appendEvent(state, company.id, "company_website_searched", "按公司名称查找候选官网", { runId: run.id, summary: "真实公开搜索 " + successes + "/" + outcomes.length + " 条完成；官网归属尚未确认。" });
  });
  return { state, result: { run: runFor(state, id), cached: false } };
}

export function websiteIdentityEvidence(sources, name) {
  const full = normalize(name), short = full.replace(/\s+(?:limited|ltd|llc|inc|incorporated|corporation|corp|co|gmbh|oy|plc)(?:\s+(?:limited|ltd|co))*$/, "");
  const names = [...new Set([full, ...(short.length >= 4 ? [short] : [])])];
  const result = [];
  for (const source of sources) {
    const pieces = [source.title || "", ...(source.snippet || "").split(/\n+|(?<=[.!?。])\s+/u)];
    for (const original of pieces) {
      // This is a literal name mention, not a declaration that the page belongs to this company.
      const quote = original.trim();
      if (!quote || quote.length > 900 || !names.some(term => (" " + normalize(quote) + " ").includes(" " + term + " "))) continue;
      result.push({ sourceId: source.id, field: "company_name", quote }); break;
    }
  }
  return result.slice(0, 2);
}
function extraIdentityPage(page) {
  const base = domain(page.url), links = [];
  for (const match of page.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/gi, "&"), page.url); url.hash = "";
      if (domain(url.href) !== base || url.href === page.url) continue;
      const label = htmlToText(match[2]) + " " + url.pathname;
      const rank = /contact|kontakt|contacto|yhteystiedot|联系我们/i.test(label) ? 2 : /about|company|meista|关于/i.test(label) ? 1 : 0;
      if (rank) links.push({ url: url.href, rank });
    } catch { /* Only observed safe, same-site links are eligible. */ }
  }
  return links.sort((a, b) => b.rank - a.rank)[0]?.url;
}
function uniqueContacts(contacts, limit = 30) {
  const entries = new Map();
  for (const item of contacts) {
    const key = item.type + ":" + (item.type === "phone" ? item.value.replace(/\D/g, "") : item.value.toLowerCase());
    if (!entries.has(key)) entries.set(key, item);
  }
  return [...entries.values()].slice(0, limit);
}
function candidateHash(candidate) { return hash({ id: candidate.id, url: candidate.url, evidence: candidate.evidence, identityEvidence: candidate.identityEvidence, contacts: candidate.contacts, inspectedAt: candidate.inspectedAt }); }
export async function inspectCompanyWebsite(payload) {
  const { runId, candidateId } = z.object({ runId: idSchema, candidateId: idSchema }).parse(payload);
  const initial = await readPlatform(), run = runFor(initial, runId), target = candidateFor(run, candidateId); currentCompany(initial, run);
  if (target.inspectedAt && target.status !== "inspecting") return { state: initial, result: { run, candidate: target, cached: true } };
  await mutatePlatform(state => {
    const live = runFor(state, runId), candidate = candidateFor(live, candidateId); currentCompany(state, live);
    if (candidate.status === "inspecting") fail("WEBSITE_INSPECTING", "该网站正在核对，请等待本次请求。", 409);
    if (live.inspectionCount >= WEBSITE_LIMITS.inspectPerRun) fail("WEBSITE_INSPECT_LIMIT", "本轮已读取 3 个候选，请先核对已有原文。", 429);
    domain(candidate.url); live.inspectionCount++; candidate.status = "inspecting";
  });
  const sources = [], contacts = [], warnings = []; let pagesFetched = 0;
  try {
    const first = await fetchPublicPage(target.url); pagesFetched++; sources.push(discoveryPageEvidence(first)); contacts.push(...publicContacts(first));
    if (domain(first.url) !== target.domain) warnings.push("网站跳转到了其他域名，请特别核对公司身份，不能只依赖初始搜索域名。");
    const next = extraIdentityPage(first);
    if (next) {
      try {
        const second = await fetchPublicPage(next); pagesFetched++;
        if (domain(second.url) !== domain(first.url)) warnings.push("补充页面跳到其他域名，未采用该页原文和联系方式。");
        else if (!sources.some(source => source.url === second.url)) { sources.push(discoveryPageEvidence(second)); contacts.push(...publicContacts(second)); }
      } catch (error) { warnings.push(error.publicError ? error.message : "补充页面读取失败；只保留实际取得的原文。"); }
    }
  } catch (error) { warnings.push(error.publicError ? error.message : "网站读取失败；没有生成替代原文。"); }
  const state = await mutatePlatform(state => {
    const live = runFor(state, runId), candidate = candidateFor(live, candidateId);
    candidate.evidence = sources; candidate.contacts = uniqueContacts(contacts); candidate.identityEvidence = websiteIdentityEvidence(sources, live.criteria.name);
    candidate.pagesFetched = pagesFetched; candidate.inspectedAt = new Date().toISOString();
    candidate.status = !sources.length ? "blocked" : candidate.identityEvidence.length ? "needs_review" : "needs_evidence";
    candidate.warnings = [...warnings, "名称原文只是身份线索，可能涉及同名公司、品牌、集团或第三方介绍；请打开来源确认这是该客户自己的官网。", "联系人岗位、采购需求、付款能力和所在国家仍未验证。", ...(!candidate.identityEvidence.length ? ["已读取页面未找到对应公司名称原文，暂不能自动补入；可先核对公司名称后重新检索。"] : [])];
    const resolved = sources[0]?.url;
    const existing = resolved && state.companies.find(company => company.id !== live.companyId && company.website && companyIdentity(company) === domain(resolved));
    if (existing) { candidate.existingCompanyId = existing.id; candidate.warnings.push("最终域名已由另一条企业记录使用，不能补入或自动合并。"); }
    candidate.candidateHash = candidateHash(candidate);
    if (live.sourceKind === "manual_url") { live.status = sources.length ? "complete" : "failed"; live.finishedAt = new Date().toISOString(); }
  });
  const live = runFor(state, runId); return { state, result: { run: live, candidate: candidateFor(live, candidateId), cached: false } };
}
export async function attachCompanyWebsite(payload) {
  const input = z.object({ mode: z.literal("attach").optional(), runId: idSchema, candidateId: idSchema, expectedCandidateHash: z.string().length(64), expectedRevision: z.number().int().positive(), confirmIdentity: z.literal(true), clientRequestId: idSchema }).strict().parse(payload);
  const result = { companyId: "", duplicate: false };
  const requestHash = hash({ runId: input.runId, candidateId: input.candidateId, candidateHash: input.expectedCandidateHash });
  const state = await mutatePlatform(state => {
    const run = runFor(state, input.runId), candidate = candidateFor(run, input.candidateId), company = findCompany(state, run.companyId);
    if (!candidate.inspectedAt || candidate.status !== "needs_review" || !candidate.identityEvidence.length) fail("WEBSITE_IDENTITY_EVIDENCE_REQUIRED", "请先读取网站原文，并核对公司名称线索后再确认归属。", 409);
    if (candidate.candidateHash !== input.expectedCandidateHash || candidateHash(candidate) !== input.expectedCandidateHash) fail("WEBSITE_CANDIDATE_CHANGED", "候选原文已变化，请重新查看后确认。", 409);
    const priorRequest = state.websiteResolutionRuns.flatMap(item => item.attachments || []).find(item => item.clientRequestId === input.clientRequestId);
    if (priorRequest) {
      if (priorRequest.requestHash !== requestHash || priorRequest.companyId !== company.id) fail("WEBSITE_REQUEST_CONFLICT", "同一次保存标识不能用于其他候选。", 409);
      result.companyId = company.id; result.duplicate = true; return;
    }
    if (candidate.attachedCompanyId === company.id) { result.companyId = company.id; result.duplicate = true; return; }
    currentCompany(state, run);
    if (input.expectedRevision !== company.revision || input.expectedRevision !== run.companyRevision) fail("REVISION_CONFLICT", "企业资料已更新，请重新核对后再补入官网。", 409);
    const website = validatePublicUrl(candidate.evidence[0].url).href;
    if (state.companies.some(item => item.id !== company.id && item.website && companyIdentity(item) === companyIdentity({ website }))) fail("DUPLICATE_COMPANY", "这个官网已经属于另一条客户记录，请先人工核对，未自动合并。", 409);
    const now = new Date().toISOString();
    company.website = website;
    company.evidence ||= []; const ids = new Set(company.evidence.map(item => item.id));
    company.evidence.push(...structuredClone(candidate.evidence.filter(item => !ids.has(item.id))));
    company.contacts = uniqueContacts([...(company.contacts || []), ...structuredClone(candidate.contacts)], Infinity);
    company.websiteResolution = { runId: run.id, candidateId: candidate.id, confirmedAt: now, method: "human_confirmed", sourceKind: run.sourceKind || "public_search", sourceIds: candidate.evidence.map(item => item.id) };
    company.revision++; company.updatedAt = now;
    candidate.attachedCompanyId = company.id;
    run.attachments ||= []; run.attachments.push({ clientRequestId: input.clientRequestId, requestHash, companyId: company.id, createdAt: now });
    appendEvent(state, company.id, "company_website_attached", "人工核对后补入企业官网", { runId: run.id, candidateId: candidate.id, summary: "仅补官网、实际网页来源和显式联系入口；未改客户等级、跟进阶段或询价记录。" });
    result.companyId = company.id;
  });
  return { state, result };
}
