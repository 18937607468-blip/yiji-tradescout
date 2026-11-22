import { createHash } from "node:crypto";

export const ENGINE_VERSION = "fitment-evidence-1.0";
export const INPUT_FIELDS = ["vehicleModel", "axleBrand", "axleModel", "year", "brakeSystem", "partType", "loadTons", "partCode", "codeNamespace", "widthMm", "thicknessMm", "drumDiameterMm", "photoUrl", "materialGrade", "quantity", "unit", "currency", "incoterm", "destination", "accessories", "rawWidth", "rawThickness", "sizeCode"];
const SPEC_FIELDS = INPUT_FIELDS.filter(k => !["quantity", "currency", "unit", "incoterm", "destination", "accessories", "photoUrl"].includes(k));
const PART_TYPES = ["brake_lining", "disc_brake_pad", "brake_shoe", "wind_power", "unknown"];
const NAMESPACES = ["WVA", "OE", "INTERNAL", "BFMC", "unknown"];
const comparable = value => String(value || "").normalize("NFKC").trim().toUpperCase().replace(/\s+/g, " ");
const same = (a, b) => comparable(a) === comparable(b);
const distinct = values => [...new Set(values)];
function fail(code, message) { throw Object.assign(new Error(message), { code, status: 400, publicError: true }); }
export function normalizeInputs(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("INVALID_INPUTS", "询价条件必须是字段对象。");
  const inputs = {};
  for (const key of INPUT_FIELDS) {
    if (raw[key] != null && typeof raw[key] !== "string") fail("INVALID_INPUTS", `${key} 请填写文本；未知条件留空。`);
    inputs[key] = String(raw[key] || "").trim();
    if (inputs[key].length > (key === "photoUrl" ? 2048 : 300)) fail("INVALID_INPUTS", `${key} 内容过长。`);
  }
  inputs.partType ||= "unknown"; inputs.codeNamespace ||= "unknown";
  inputs.codeNamespace = inputs.codeNamespace === "unknown" ? "unknown" : inputs.codeNamespace.toUpperCase();
  inputs.currency = inputs.currency.toUpperCase(); inputs.incoterm = inputs.incoterm.toUpperCase();
  if (!PART_TYPES.includes(inputs.partType) || !NAMESPACES.includes(inputs.codeNamespace)) fail("INVALID_INPUTS", "片型或编号体系不在支持范围内。");
  if (inputs.photoUrl) {
    try { const parsed = new URL(inputs.photoUrl); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); inputs.photoUrl = parsed.href; }
    catch { fail("INVALID_PHOTO_URL", "图片依据请填写有效的 HTTP(S) 链接；不支持脚本或本地地址格式。"); }
  }
  inputs.dimensionUnitConfirmed = raw.dimensionUnitConfirmed === true;
  return inputs;
}
export function fingerprint(inputs) { return createHash("sha256").update(JSON.stringify(normalizeInputs(inputs))).digest("hex"); }
export function specificationFingerprint(inputs) {
  const value = normalizeInputs(inputs);
  return createHash("sha256").update(JSON.stringify(Object.fromEntries([...SPEC_FIELDS, "dimensionUnitConfirmed"].map(k => [k, value[k]])))).digest("hex");
}
const catalogueEvidence = (page, printedPage, row, quote) => [{ title: `冠英 kooying catalog · ${row}`, url: "", page: `PDF ${page} / 印刷页 ${printedPage}`, quote }];
function companyPart(id, code, wva, bfmc, brand, width, thickness, page, printedPage, outer, inner, holes) {
  return {
    id, partNumber: code, namespace: "INTERNAL", name: "鼓式制动衬片", manufacturer: "冠英 KOOYING", kind: "company", partType: "brake_lining",
    aliases: [{ namespace: "INTERNAL", code }, { namespace: "WVA", code: wva }, { namespace: "BFMC", code: bfmc }],
    axleBrand: brand, axleModel: "", brakeSystem: "", yearMin: null, yearMax: null,
    dimensions: { width, thickness, drumDiameter: "", unit: "" },
    dimensionsRaw: { A_outer_arch: outer, B_inner_arch: inner, C_width: width, D_thickness: thickness, holes },
    evidence: catalogueEvidence(page, printedPage, code, `${code}; WVA ${wva}; BFMC ${bfmc}; Application ${brand}; C width ${width}; D thickness ${thickness}`),
    note: "厂商目录只核验了应用品牌与产品行；未核验具体车桥、制动器、年份及与原厂维修包的互换关系。尺寸单位未在该表明示；斜杠值保留原文。",
    evidenceStatus: "manufacturer_catalogue_row_verified",
  };
}
const BPW_PDF = "https://www.bpw.de/fileadmin/user_upload/Service/Downloads/BPW-2025-Repair_kits_Spare_parts-Repsatz_31112501e.pdf";
export const VERIFIED_FITMENT_CATALOG = [
  companyPart("kooying-gys-007", "GYS-007", "19032", "BC/36/1", "BPW", "180", "17.5/10.5", 6, "09", "220", "204", "10"),
  companyPart("kooying-gys-018", "GYS-018", "19094", "BC/37/1", "BPW", "200", "17.5/10.5", 6, "10", "220", "204", "10"),
  companyPart("kooying-gys-054", "GYS-054", "19591", "BC/81/1", "BPW", "220", "17.5/10.5", 7, "12", "220", "204", "10"),
  companyPart("kooying-gys-009", "GYS-009", "19036", "DF/25/1", "SAF, TRAILOR YORK TRAILERS", "178", "19/16", 6, "09", "204", "185", "12"),
  companyPart("kooying-gys-034", "GYS-034", "19369", "FU/5/4", "SAF, TRAILOR YORK TRAILERS", "219", "11.5/18", 7, "11", "212", "191", "12"),
  ...[["18", "09.801.07.41.0"], ["19", "09.801.07.42.0"], ["20", "09.801.07.43.0"]].map(([thickness, partNumber]) => ({
    id: "bpw-" + partNumber, partNumber, namespace: "OE", name: "BPW 原厂摩擦衬片维修包参考", manufacturer: "BPW", kind: "oem", partType: "brake_lining",
    aliases: [{ namespace: "OE", code: partNumber }], axleBrand: "BPW", axleModel: "MVB FST 10010", brakeSystem: "SN 4218", yearMin: 2023, yearMax: null,
    dimensions: { width: "", thickness, drumDiameter: "", unit: "mm" },
    evidence: [{ title: "BPW Repair kits / Spare parts 2025", url: BPW_PDF, page: "印刷页 7", quote: `MVB FST 10010; SN 4218; from 2023; ${thickness} mm; ${partNumber}` }],
    note: "原厂维修包的条件参考，不能据此推导冠英 SKU 适配或正式装配结论；需要核对铭牌、配置与原厂完整说明。", evidenceStatus: "oem_reference_verified",
  })),
];
export function defaultFitmentCatalog() { return structuredClone(VERIFIED_FITMENT_CATALOG); }
function exactCode(row, inputs) {
  return (row.aliases || [{ code: row.partNumber, namespace: row.namespace }]).some(a => same(a.code, inputs.partCode) && (inputs.codeNamespace === "unknown" || a.namespace === inputs.codeNamespace));
}
const compact = value => comparable(value).replace(/[\s-]/g, "");
function asNumber(value) { return /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : null; }
function brandMatches(row, brand) { return row.axleBrand.split(/[,，]/).map(comparable).some(v => v === comparable(brand)); }

function compareRow(row, inputs) {
  const reasons = [], conflicts = [], missing = [];
  let relevance = 0;
  // 原厂维修包只在有具体编号/车桥/制动器线索时参与；品牌不能跨成产品互换链。
  if (row.kind === "oem" && !inputs.partCode && !inputs.axleModel && !inputs.brakeSystem) return { eligible: false, reasons: [], missing, relevance: 0 };
  if (inputs.partCode) {
    if (!exactCode(row, inputs)) return { eligible: false, reasons: ["编号或编号体系未精确匹配；未使用模糊编号替代。"], missing, relevance };
    reasons.push(`精确编号命中：${inputs.codeNamespace} ${inputs.partCode}`); relevance += 100;
    if (inputs.codeNamespace === "unknown") missing.push("请确认编号体系（WVA / OE / INTERNAL / BFMC）");
  }
  if (inputs.axleBrand) {
    if (!brandMatches(row, inputs.axleBrand)) conflicts.push(`品牌冲突：目录应用为 ${row.axleBrand}`);
    else { reasons.push(`目录应用品牌包含 ${inputs.axleBrand}`); relevance += 10; }
  }
  for (const [field, label] of [["axleModel", "车桥型号"], ["brakeSystem", "制动器型号"]]) {
    if (inputs[field] && row[field]) {
      if (compact(inputs[field]) !== compact(row[field])) conflicts.push(`${label}冲突：证据为 ${row[field]}`);
      else { reasons.push(`${label}与证据一致：${row[field]}`); relevance += 30; }
    } else if (!row[field]) missing.push(`目录未建立具体${label}关系`);
    else missing.push(`待确认${label}：${row[field]}`);
  }
  if (inputs.partType !== "unknown" && row.partType !== inputs.partType) conflicts.push(`片型冲突：目录类型为 ${row.partType}`);
  else if (inputs.partType === "unknown") missing.push("片型（鼓式衬片、盘式片或制动蹄）待确认");
  if (inputs.year) {
    const year = /^\d{4}$/.test(inputs.year) ? Number(inputs.year) : null;
    if (!year) missing.push("年份需要四位数字，当前原值未用于范围判定");
    else if ((row.yearMin && year < row.yearMin) || (row.yearMax && year > row.yearMax)) conflicts.push(`年份超出来源适用范围：${row.yearMin || "不限"}–${row.yearMax || "以后"}`);
    else if (row.yearMin || row.yearMax) reasons.push(`年份在来源范围内：${inputs.year}`);
    else missing.push("目录未给年份范围，不能从年份判断适配");
  } else if (row.yearMin || row.yearMax) missing.push(`待确认生产年份（该来源从 ${row.yearMin || "未注明"} 年起）`);
  for (const [field, rawField, dim, label] of [["widthMm", "rawWidth", "width", "宽度"], ["thicknessMm", "rawThickness", "thickness", "厚度"], ["drumDiameterMm", null, "drumDiameter", "制动鼓直径"]]) {
    const catalogValue = row.dimensions?.[dim] || "";
    if (rawField && inputs[rawField]) {
      if (!catalogValue) missing.push(`来源未提供${label}原值`);
      else if (!same(inputs[rawField], catalogValue)) conflicts.push(`${label}目录原值不符：${catalogValue}（单位另核）`);
      else { reasons.push(`${label}目录原值一致：${catalogValue}（尚未推断单位）`); relevance += 5; }
    }
    if (inputs[field]) {
      if (asNumber(inputs[field]) === null) { missing.push(`${label}输入不是可比较的 mm 数值，已保留原文`); continue; }
      if (!catalogValue) { missing.push(`来源未提供可核对的${label}`); continue; }
      if (!row.dimensions.unit && !inputs.dimensionUnitConfirmed) { missing.push(`目录${label}单位未明示；可用“目录原值”筛选，需人工确认单位`); continue; }
      if (asNumber(catalogValue) === null) { missing.push(`目录${label}为 ${catalogValue}，不能拆分成单一 mm 值`); continue; }
      if (asNumber(inputs[field]) !== asNumber(catalogValue)) conflicts.push(`${label}冲突：输入 ${inputs[field]} mm，来源 ${catalogValue}${row.dimensions.unit || "（已确认同单位）"}`);
      else { reasons.push(`${label}一致：${inputs[field]} mm`); relevance += 5; }
    }
  }
  if (inputs.vehicleModel) missing.push("整车型号不能替代当前车桥及制动器识别；需核对是否改装或换桥");
  if (inputs.loadTons) missing.push("当前来源未提供载荷适用关系");
  if (inputs.sizeCode) missing.push(`规格代号 ${inputs.sizeCode} 保留原文，STD / 1+ / 2+ 的具体含义需企业核对`);
  if (inputs.photoUrl) missing.push("图片仅保存为原始依据，本次规则引擎未执行图像识别");
  if (!inputs.materialGrade) missing.push("材质/配方待确认");
  if (!inputs.partCode && !inputs.axleBrand && !inputs.axleModel && !inputs.brakeSystem) return { eligible: false, reasons: [], missing, relevance: 0 };
  if (!relevance) return { eligible: false, reasons: [], missing, relevance: 0 };
  return { eligible: !conflicts.length, reasons: conflicts.length ? conflicts : reasons, missing: distinct(missing), relevance };
}

function quoteFor(row, inputs, options) {
  const quantity = asNumber(inputs.quantity);
  if (!options.companyId || !quantity || quantity <= 0) return [];
  const required = ["materialGrade", "currency", "unit", "incoterm", "destination", "accessories"];
  if (required.some(k => !inputs[k])) return [];
  const specHash = specificationFingerprint(inputs), now = Date.parse(options.now || new Date().toISOString());
  const refs = (options.quoteHistory || []).filter(q => q.companyId === options.companyId && q.dataClass === (options.dataClass || "real") && q.authorized === true && q.partNumber === row.partNumber && q.namespace === row.namespace && required.every(k => same(q[k], inputs[k])) && quantity >= q.quantityMin && quantity <= q.quantityMax && q.specificationFingerprint === specHash && now >= Date.parse(q.validFrom) && now <= Date.parse(q.validUntil) && Number.isFinite(q.unitPrice) && q.unitPrice > 0);
  if (!refs.length) return [];
  return [{ candidateId: row.id, partNumber: row.partNumber, namespace: row.namespace, min: Math.min(...refs.map(q => q.unitPrice)), max: Math.max(...refs.map(q => q.unitPrice)), currency: inputs.currency, unit: inputs.unit, incoterm: inputs.incoterm, destination: inputs.destination, materialGrade: inputs.materialGrade, accessories: inputs.accessories, quantityMin: Math.max(...refs.map(q => q.quantityMin)), quantityMax: Math.min(...refs.map(q => q.quantityMax)), validUntil: refs.map(q => q.validUntil).sort()[0], sourceTitle: refs[0].sourceTitle, sourceUrl: refs[0].sourceUrl, referenceIds: refs.map(q => q.id), label: "历史参考价，非正式报价" }];
}
export function analyzeInquiry(rawInputs = {}, options = {}) {
  const start = performance.now(), inputs = normalizeInputs(rawInputs);
  const catalog = options.catalog || defaultFitmentCatalog();
  const trace = [{ step: "输入核对", status: "done", detail: "按原始条件比对已核验目录；本步骤不调用语言模型，不发出报价。" }];
  const excluded = [], matching = [], related = [];
  for (const row of catalog) {
    const check = compareRow(row, inputs);
    if (!check.eligible) { if (check.reasons.length) excluded.push({ id: row.id, partNumber: row.partNumber, namespace: row.namespace, reasons: check.reasons }); continue; }
    const relation = (options.relations || []).find(r => r.candidateId === row.id && options.inquiryId && r.inquiryId === options.inquiryId && r.companyId === options.companyId && r.dataClass === (options.dataClass || "real") && r.status === "confirmed" && r.specificationFingerprint === specificationFingerprint(inputs));
    matching.push({ ...structuredClone(row), status: relation ? "confirmed" : "candidate", missing: relation ? check.missing.filter(m => /材质|配方/.test(m)) : check.missing, reasons: [...check.reasons, ...(relation ? [`人工核准：${relation.confirmedBy}；仅限本次条件`] : [])], note: relation ? `人工核准关系，仅限来源记录配置；${row.note}` : row.note, _relevance: check.relevance });
  }
  matching.sort((a, b) => b._relevance - a._relevance || Number(b.kind === "company") - Number(a.kind === "company") || a.id.localeCompare(b.id));
  // 有具体车桥/制动器条件时，缺失映射的品牌目录行移到旁证区，不能混入适配候选。
  if (!inputs.partCode && (inputs.axleModel || inputs.brakeSystem)) {
    for (let index = matching.length - 1; index >= 0; index--) {
      const row = matching[index];
      if ((inputs.axleModel && !row.axleModel) || (inputs.brakeSystem && !row.brakeSystem)) related.unshift(...matching.splice(index, 1));
    }
  }
  const discriminators = [];
  for (const [dim, field, rawField, label] of [["thickness", "thicknessMm", "rawThickness", "厚度"], ["width", "widthMm", "rawWidth", "片宽"]]) {
    const values = distinct(matching.map(c => c.dimensions?.[dim]).filter(Boolean));
    if (values.length > 1 && !inputs[rawField] && (!inputs[field] || (!inputs.dimensionUnitConfirmed && matching.some(c => !c.dimensions?.unit)))) {
      const unitKnown = matching.every(c => c.dimensions?.unit === "mm");
      discriminators.push(label + "是当前候选的区分项：" + values.join(" / ") + (unitKnown ? " mm；请核对原件或图纸" : "（目录原值，单位另核）；请提供对应原值"));
    }
  }
  const commercialMissing = [];
  for (const [key, label] of [["materialGrade", "材质/配方"], ["quantity", "采购数量"], ["unit", "计价单位"], ["currency", "币种"], ["incoterm", "贸易条款"], ["destination", "目的地"], ["accessories", "附件及附件材质"]]) {
    if (!inputs[key]) commercialMissing.push(label + "待确认，暂不能核价");
  }
  const missing = distinct([...discriminators, ...matching.flatMap(c => c.missing), ...commercialMissing]);
  if (!matching.length && related.length) missing.unshift("只找到品牌相关目录，尚未建立所填具体车桥/制动器与产品的映射；需要铭牌或原件依据");
  if (!inputs.partCode && !inputs.axleBrand && !inputs.axleModel && !inputs.brakeSystem) missing.unshift("请提供原件编号，或车桥品牌/型号与制动器型号；单靠整车型号不足以配型");
  if (inputs.partCode && !matching.length) missing.unshift("没有与该编号及当前条件一致的已核验记录；请核对编号体系、照片或原件标签");
  if (!matching.length && !missing.length) missing.push("当前小范围目录没有匹配证据；需要原件编号、铭牌或技术确认，不能理解为市场上不存在对应产品");
  const quoteRanges = matching.flatMap(row => quoteFor(row, inputs, options));
  if (!quoteRanges.length) trace.push({ step: "历史价格", status: "pending", detail: "待核价：无同时匹配件号、规格、材质、币种、单位、条款、目的地、附件、数量及有效期的已授权历史价格。" });
  else trace.push({ step: "历史价格", status: "reference", detail: "仅列出条件完全一致且有效的历史参考价；价格不证明零件适配。" });
  trace.push({ step: "候选过滤", status: "done", detail: `核验目录 ${catalog.length} 条，条件候选 ${matching.length} 条，排除 ${excluded.length} 条；展示最多 3 条，未宣称目录完整或唯一适配。` });
  const hasConflict = excluded.some(row => row.reasons.some(r => !r.startsWith("编号或编号体系")));
  return {
    inputs, candidates: matching.slice(0, 3).map(({ _relevance, ...row }) => row), totalCandidates: matching.length,
    candidateIds: matching.map(row => row.id), relatedCatalogue: related.slice(0, 3).map(({ _relevance, ...row }) => row), totalRelatedCatalogue: related.length,
    excluded, missing: distinct(missing), questions: distinct(missing).slice(0, 4).map(text => `请协助确认：${text}？`), quoteRanges,
    quoteStatus: quoteRanges.length ? "reference_available" : "pending",
    status: matching.some(c => c.status === "confirmed") ? "confirmed" : matching.length ? "candidates" : hasConflict ? "conflict" : "needs_information",
    elapsedMs: Math.round((performance.now() - start) * 100) / 100, engineVersion: ENGINE_VERSION, inputFingerprint: fingerprint(inputs), trace,
    notice: "条件候选用于询价分流与人工核对；一条搜索结果不等于唯一适配。原厂参考与冠英产品不自动建立互换关系。",
  };
}
