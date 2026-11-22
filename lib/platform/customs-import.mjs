import Papa from "papaparse";
import { createHash, randomUUID } from "node:crypto";
import { mutatePlatform } from "./store.mjs";

export const CUSTOMS_LIMITS = { maxRows: 500, maxTextBytes: 500000 };
const FIELDS = ["companyName", "hsCode", "description", "country", "date", "website", "role", "supplier"];
const FILTERS = ["hsPrefix", "keyword", "country", "dateFrom", "dateTo"];
const ALIASES = {
  companyName: ["company", "companyname", "company_name", "buyer", "buyername", "importer", "consignee", "企业名称", "公司名称", "公司名", "采购商", "采购商名称", "买家", "买家名称", "进口商", "进口商名称", "收货人", "收货人名称"],
  hsCode: ["hs", "hscode", "hs_code", "hscodes", "海关编码", "海关码", "商品编码", "hs编码"],
  description: ["description", "productdescription", "goodsdescription", "product", "货物描述", "产品描述", "商品描述", "货描", "品名"],
  country: ["country", "market", "buyercountry", "importercountry", "countryofbuyer", "国家", "国家地区", "采购商国家", "进口国", "目的国"],
  date: ["date", "tradedate", "shipmentdate", "交易日期", "日期", "报关日期", "进口日期", "提单日期"],
  website: ["website", "url", "companywebsite", "官网", "企业官网", "网址"],
  role: ["role", "buyerrole", "companyrole", "角色", "客户角色", "企业角色"],
  supplier: ["supplier", "suppliername", "exporter", "shipper", "供应商", "供应商名称", "出口商", "出口商名称", "发货人"],
};
function fail(code, message, status = 400) { throw Object.assign(new Error(message), { code, status, publicError: true }); }
const normalized = value => String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const headerKey = value => normalized(value).replace(/[\s_-]/g, "");
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function short(value, label, limit = 300) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") fail("INVALID_FIELDS", label + " 必须是文本。");
  const clean = value.trim(); if (clean.length > limit) fail("INVALID_FIELDS", label + " 内容过长。"); return clean;
}
function isoDate(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/.exec(raw);
  if (!match) return "";
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return match[1] + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}
function hsDigits(raw) {
  if (!/^[0-9.\s]+$/.test(raw || "")) return "";
  return raw.replace(/[.\s]/g, "");
}
function safeWebsite(raw) {
  if (!raw) return "";
  try {
    const value = new URL(raw.includes("://") ? raw : "https://" + raw);
    if (!["http:", "https:"].includes(value.protocol) || value.username || value.password || !value.hostname.includes(".")) return "";
    return value.href;
  } catch { return ""; }
}
function websiteIdentity(raw) {
  const safe = safeWebsite(raw); if (!safe) return "";
  const value = new URL(safe), host = value.hostname.toLowerCase().replace(/^www\./, "");
  return ["facebook.com", "linkedin.com", "instagram.com", "alibaba.com", "made-in-china.com"].some(d => host === d || host.endsWith("." + d))
    ? host + value.pathname.replace(/\/$/, "") + (value.searchParams.get("id") ? "?id=" + value.searchParams.get("id") : "") : host;
}
function companyClass(company) { return company.dataClass === "synthetic" || company.isDemo === true ? "synthetic" : "real"; }
function companyKey(name, country, dataClass) { return digest([normalized(name), normalized(country), dataClass]); }
function parseInput(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("INVALID_FIELDS", "导入请求格式无效。");
  if (payload.authorized !== true) fail("CUSTOMS_AUTH_REQUIRED", "请确认有权使用这些导出数据；本功能不会连接海关账户。");
  if (!["real", "synthetic"].includes(payload.dataClass)) fail("DATA_CLASS_REQUIRED", "请明确选择真实导出数据或演示样例。");
  const sourceName = short(payload.sourceName, "来源文件名称", 200);
  if (!sourceName) fail("SOURCE_REQUIRED", "请填写来源文件或导出表名称，便于逐行追溯。");
  if (typeof payload.text !== "string") fail("INVALID_TEXT", "请粘贴带表头的 CSV 或 Excel TSV 文本。");
  if (new TextEncoder().encode(payload.text).byteLength > CUSTOMS_LIMITS.maxTextBytes) fail("CUSTOMS_TEXT_LIMIT", "单次文本限 500000 UTF-8 字节（约 500 KB），请分批导入。", 413);
  if (!payload.text.trim()) fail("CUSTOMS_EMPTY", "请粘贴带表头和数据行的 CSV 或 TSV。");
  const parsed = Papa.parse(payload.text.replace(/^\uFEFF/, ""), { header: false, skipEmptyLines: "greedy", delimitersToGuess: ["\t", ",", ";"], dynamicTyping: false });
  if (parsed.errors.some(error => error.type === "Quotes")) fail("INVALID_CSV", "CSV/TSV 引号未闭合，无法可靠识别数据行。");
  const [headerRow, ...rows] = parsed.data;
  if (!headerRow?.length || !rows.length) fail("CUSTOMS_EMPTY", "至少需要一行表头与一行数据。");
  if (rows.length > CUSTOMS_LIMITS.maxRows) fail("CUSTOMS_ROW_LIMIT", "单次最多 500 条数据行，请分批处理；没有截断或偷偷导入前 500 行。", 413);
  const headers = headerRow.map(v => String(v || "").trim());
  if (headers.some(h => !h || h.length > 200) || new Set(headers.map(headerKey)).size !== headers.length) fail("CUSTOMS_HEADERS", "表头存在空白、重名或过长字段，请为每列提供不同且明确的名称。");
  const supplied = payload.mapping || {};
  if (typeof supplied !== "object" || Array.isArray(supplied)) fail("INVALID_MAPPING", "字段映射格式无效。");
  const mapping = {};
  for (const field of FIELDS) {
    mapping[field] = supplied[field] === undefined ? headers.find(h => ALIASES[field].map(headerKey).includes(headerKey(h))) || "" : short(supplied[field], field, 200);
    if (mapping[field] && !headers.includes(mapping[field])) fail("INVALID_MAPPING", "映射列不存在：" + mapping[field]);
  }
  const filters = {};
  for (const field of FILTERS) filters[field] = short(payload.filters?.[field], field, 300);
  if (filters.hsPrefix && (!/^[0-9.\s]+$/.test(filters.hsPrefix) || !hsDigits(filters.hsPrefix))) fail("INVALID_HS_FILTER", "HS 前缀只支持数字、点或空格；系统不推测丢失的编号。");
  for (const field of ["dateFrom", "dateTo"]) if (filters[field] && (!/^\d{4}-\d{2}-\d{2}$/.test(filters[field]) || !isoDate(filters[field]))) fail("INVALID_DATE_FILTER", "筛选日期请使用有效的 YYYY-MM-DD。");
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) fail("INVALID_DATE_FILTER", "起始日期不能晚于结束日期。");
  for (const [filter, field] of [["hsPrefix", "hsCode"], ["keyword", "description"], ["country", "country"], ["dateFrom", "date"], ["dateTo", "date"]]) {
    if (filters[filter] && !mapping[field]) fail("FILTER_MAPPING_REQUIRED", "使用该筛选前请先映射原表字段：" + field);
  }
  return { sourceName, headers, rows, mapping, filters, dataClass: payload.dataClass };
}
export function previewCustomsImport(payload) {
  const input = parseInput(payload), { sourceName, headers, rows, mapping, filters, dataClass } = input;
  const groups = new Map(), errors = [], seen = new Set();
  const summary = { inputRows: rows.length, matchedRows: 0, filteredRows: 0, invalidRows: 0, duplicateRows: 0, candidateCount: 0 };
  const previewHash = digest({ text: payload.text, sourceName, mapping, filters, dataClass });
  if (!mapping.companyName) return { headers, mapping, summary: { ...summary, invalidRows: rows.length }, candidates: [], errors: [{ row: 1, code: "COMPANY_COLUMN_REQUIRED", message: "请把企业名称映射到原表的一列，再重新预览；供应商与货代不会自动视为买家。" }], previewHash, limits: CUSTOMS_LIMITS, notice: "已读取原表头，尚未确定企业名称列。这里只处理授权导出文本，不连接海关在线接口。" };
  for (const [index, values] of rows.entries()) {
    const row = index + 2;
    if (values.length !== headers.length) { summary.invalidRows++; errors.push({ row, code: "COLUMN_COUNT", message: "该行列数与表头不一致，未导入。" }); continue; }
    const raw = Object.fromEntries(headers.map((header, column) => [header, String(values[column] ?? "")]));
    const pick = field => mapping[field] ? raw[mapping[field]].trim() : "";
    const name = pick("companyName"), country = pick("country"), dateRaw = pick("date"), date = isoDate(dateRaw), hsCode = pick("hsCode"), description = pick("description"), role = pick("role"), supplier = pick("supplier"), websiteRaw = pick("website");
    if (!name || name.length > 160 || country.length > 100 || hsCode.length > 100 || dateRaw.length > 200 || description.length > 12000 || role.length > 300 || supplier.length > 300 || websiteRaw.length > 2048) {
      summary.invalidRows++; errors.push({ row, code: "ROW_FIELDS", message: "企业名为空或字段超长，请核对本行原始资料。" }); continue;
    }
    const dateFilter = filters.dateFrom || filters.dateTo;
    if (dateFilter && !date) { summary.filteredRows++; errors.push({ row, code: "DATE_UNPARSED", message: "日期缺失或格式不明确，未纳入日期筛选；未猜测 Excel 日期序号或月日顺序。" }); continue; }
    const filterReasons = [];
    if (filters.hsPrefix && !hsDigits(hsCode).startsWith(hsDigits(filters.hsPrefix))) filterReasons.push("HS 前缀");
    if (filters.keyword && !normalized(description).includes(normalized(filters.keyword))) filterReasons.push("货描关键词");
    if (filters.country && normalized(country) !== normalized(filters.country)) filterReasons.push("国家/地区");
    if ((filters.dateFrom && date < filters.dateFrom) || (filters.dateTo && date > filters.dateTo)) filterReasons.push("日期范围");
    if (filterReasons.length) { summary.filteredRows++; errors.push({ row, code: "FILTERED_OUT", message: "未通过本次筛选：" + filterReasons.join("、") + "。这不等于已判定该企业无采购能力。" }); continue; }
    // Full exported row participates: separate quantities/trade IDs must not collapse.
    const content = Object.keys(raw).sort().map(header => [header, raw[header].normalize("NFKC").trim().replace(/\s+/g, " ")]);
    // Display-field mappings do not create a new transaction. Party identity remains scoped.
    const transactionHash = digest({ party: [normalized(name), normalized(country)], dataClass, content });
    const key = country ? companyKey(name, country, dataClass) : digest({ unknownCountryParty: normalized(name), dataClass, content });
    if (seen.has(transactionHash)) { summary.duplicateRows++; continue; }
    seen.add(transactionHash);
    const warnings = [];
    if (!country) warnings.push("国家未注明；该原始行作为独立待核身份，不自动合并其他同名记录或旧客户。");
    if (!role) warnings.push("原表未注明企业角色，不能直接判断是实际采购商。");
    if (/supplier|exporter|shipper|consignor|freight|forwarder|notify|供应商|出口商|发货人|货代|物流|通知方|通知人/i.test(role)) warnings.push("角色原文涉及供应商、出口方、货代或通知方，不等于真实买家。");
    if (!hsCode) warnings.push("原始 HS 编码缺失。");
    else if (!hsDigits(hsCode)) warnings.push("HS 格式无法直接筛选；保留原文，未修复科学计数法或丢失数字。");
    else if (![6, 8, 10].includes(hsDigits(hsCode).length)) warnings.push("原始 HS 长度不是 6、8 或 10 位，请核对原表、国家税则和年份；已保留原值，仍可按明确前缀粗筛，未补零或推断完整编码。");
    if (!dateRaw) warnings.push("原始交易日期缺失，无法判断交易发生时间或新鲜度。");
    else if (!date) warnings.push("日期保留原文，未自动解释歧义日期。");
    const website = safeWebsite(websiteRaw);
    if (websiteRaw && !website) warnings.push("网址格式不可靠，未写入可访问的企业官网字段。");
    const record = { row, name, hsCode, description, country, date, dateRaw, role, supplier, website, websiteRaw, sourceName, raw, transactionHash };
    let group = groups.get(key);
    if (!group) {
      group = { key, name, country, website, role: role || "未注明", recordCount: 0, hsCodes: [], descriptions: [], dates: [], suppliers: [], sourceRows: [], warnings: [], records: [], _websites: new Set(), _roles: new Set() };
      groups.set(key, group);
    }
    group.recordCount++; group.records.push(record); group.sourceRows.push(row);
    if (hsCode && !group.hsCodes.includes(hsCode)) group.hsCodes.push(hsCode);
    if (description && !group.descriptions.includes(description)) group.descriptions.push(description);
    if ((date || dateRaw) && !group.dates.includes(date || dateRaw)) group.dates.push(date || dateRaw);
    if (supplier && !group.suppliers.includes(supplier)) group.suppliers.push(supplier);
    group.warnings = [...new Set([...group.warnings, ...warnings])];
    if (website) group._websites.add(website);
    if (role) group._roles.add(role);
    summary.matchedRows++;
  }
  const candidates = [...groups.values()].map(({ _websites, _roles, ...group }) => {
    if (new Set([..._websites].map(websiteIdentity)).size > 1) { group.website = ""; group.identityConflict = true; group.warnings.push("同名同国家记录涉及多个不同网站主体；身份冲突，请先人工拆分后再导入。"); }
    else group.website = [..._websites][0] || "";
    group.role = [..._roles].join(" / ") || "未注明";
    return group;
  });
  summary.candidateCount = candidates.length;
  return { headers, mapping, summary, candidates, errors, previewHash, limits: CUSTOMS_LIMITS, notice: "仅处理你有权使用的本地导出明细，不是海关在线查询。HS/货描只能辅助筛选；交易记录不证明当前采购意向、付款能力或零件适配。行号为含表头的表格记录序号。" };
}
function newCompany(candidate, dataClass, now) {
  return { id: randomUUID(), name: candidate.name, website: candidate.website, market: candidate.country, productRefs: [],
    buyerRole: candidate.role === "未注明" ? "待核验；海关明细未注明角色" : "海关角色原文（待核验）：" + candidate.role.slice(0, 200),
    grade: "unknown", gradeSource: "unknown", stage: "待研究", owner: "", nextAction: "核对企业官网、产品相关性及实际采购角色", nextFollowUpAt: "", notes: "",
    sourceUrl: "", sourceKind: "customs_import", evidence: [], communications: [], contacts: [], memoryProposals: [], memoryHistory: [], memoryByInquiry: {}, researchStatus: "not_started",
    revision: 1, createdAt: now, updatedAt: now, dataClass, isDemo: dataClass === "synthetic",
    missingEvidence: ["企业身份与官网归属待核验", "实际采购角色待确认", "产品适配与当前采购计划未知", "公开商务联系人待补充", "付款能力未验证"],
  };
}
export async function importCustomsSelection(payload) {
  const preview = previewCustomsImport(payload);
  if (payload.previewHash !== preview.previewHash) fail("CUSTOMS_PREVIEW_CHANGED", "原文、字段映射或筛选条件已经变化，请重新预览后选择企业。", 409);
  if (!Array.isArray(payload.selectedKeys) || !payload.selectedKeys.length || payload.selectedKeys.length > 500 || payload.selectedKeys.some(key => typeof key !== "string")) fail("CUSTOMS_SELECTION_REQUIRED", "请先手动勾选至少一家预览企业。");
  const selected = [...new Set(payload.selectedKeys)], available = new Map(preview.candidates.map(c => [c.key, c]));
  if (selected.some(key => !available.has(key))) fail("CUSTOMS_SELECTION_CHANGED", "选中的企业不在本次预览中，请重新预览。", 409);
  const summary = { selectedCompanies: selected.length, importedCompanies: 0, mergedCompanies: 0, importedRecords: 0, duplicateRecords: 0, batchId: randomUUID() };
  const state = await mutatePlatform(next => {
    next.customsBatches ||= []; next.customsRecords ||= [];
    const now = new Date().toISOString(), existingRecords = new Map(next.customsRecords.map(record => [record.transactionHash, record]));
    for (const key of selected) {
      const candidate = available.get(key);
      const pendingRecords = candidate.records.filter(record => !existingRecords.has(record.transactionHash));
      summary.duplicateRecords += candidate.recordCount - pendingRecords.length;
      if (!pendingRecords.length) { summary.mergedCompanies++; continue; }
      if (candidate.identityConflict) fail("CUSTOMS_IDENTITY_CONFLICT", "同名同国家记录有多个不同网站主体，请先核对并拆分原始记录，未自动合并。", 409);
      const matches = candidate.country ? next.companies.filter(company => companyClass(company) === payload.dataClass && companyKey(company.name, company.market, payload.dataClass) === key) : [];
      if (matches.length > 1) fail("CUSTOMS_IDENTITY_AMBIGUOUS", "工作区存在多条同名同国家客户，请先人工核对身份，未自动选择合并对象。", 409);
      let company = matches[0], created = false, added = 0;
      if (company?.website && candidate.website && websiteIdentity(company.website) !== websiteIdentity(candidate.website)) fail("CUSTOMS_IDENTITY_CONFLICT", "同名同国家客户已有官网与本次来源指向不同主体，请先人工核验身份，未合并证据。", 409);
      if (!company) { company = newCompany(candidate, payload.dataClass, now); next.companies.push(company); created = true; summary.importedCompanies++; }
      else summary.mergedCompanies++;
      company.evidence ||= [];
      for (const source of pendingRecords) {
        const record = { ...source, id: randomUUID(), companyId: company.id, batchId: summary.batchId, dataClass: payload.dataClass, importedAt: now };
        next.customsRecords.push(record); existingRecords.set(source.transactionHash, record); summary.importedRecords++; added++;
        company.evidence.push({ id: record.id, type: "document", title: payload.sourceName + " · 表格行 " + source.row, sourceKind: "authorized_export",
          snippet: "原始 HS：" + (source.hsCode || "未注明") + "；货描：" + (source.description || "未注明") + "；角色：" + (source.role || "未注明") + "；国家：" + (source.country || "未注明") + "；日期原文：" + (source.dateRaw || "未注明") + "；供应商：" + (source.supplier || "未注明"),
          capturedAt: now, status: "reported", customsRecordId: record.id, sourceName: payload.sourceName, sourceRow: source.row, dataClass: payload.dataClass });
      }
      if (!created && added) { company.updatedAt = now; company.revision = (company.revision || 0) + 1; }
      if (added) next.events.push({ id: randomUUID(), companyId: company.id, type: "customs_evidence_added", title: "导入授权海关明细证据", createdAt: now, summary: "新增 " + added + " 条原始记录；人工等级、阶段与跟进安排未改变。", batchId: summary.batchId, dataClass: payload.dataClass });
    }
    next.customsBatches.push({ id: summary.batchId, sourceName: payload.sourceName, previewHash: preview.previewHash, mapping: preview.mapping, filters: Object.fromEntries(FILTERS.map(key => [key, payload.filters?.[key]?.trim() || ""])), dataClass: payload.dataClass,
      authorized: true, selectedKeys: selected, inputRows: preview.summary.inputRows, importedAt: now, summary: { ...summary }, sourceKind: "authorized_export", onlineQuery: false });
  });
  return { state, summary };
}
