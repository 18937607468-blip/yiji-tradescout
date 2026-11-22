// The enterprise's own Q&A reference list. This is not a country/year tariff crosswalk.
export const CUSTOMS_QA_SOURCE_URL = "https://zju-ailab.feishu.cn/wiki/JuuTwfjkZiT1iYku6rkcSpuonLb";
export const CUSTOMS_PLATFORM_URL = "https://admin.hqsmartcloud.com/#/home";
export const COMPANY_HS_CATALOG = Object.freeze([
  { category: "brake_lining", label: "鼓式制动衬片", english: "brake lining", companyCode: "6813810000", supported: true },
  { category: "disc_brake_pad", label: "盘式制动片", english: "brake pad", companyCode: "8708309990", supported: true },
  { category: "brake_shoe", label: "蹄铁总成", english: "brake shoes", companyCode: "8708301000", supported: true },
  { category: "clutch_facing", label: "离合器面片", english: "clutch facing", companyCode: "6813890000", supported: false },
].map(item => Object.freeze({ ...item, sourceUrl: CUSTOMS_QA_SOURCE_URL })));

export function assessCompanyHs(value = "") {
  const rawCode = String(value ?? "");
  const cleaned = rawCode.trim();
  const normalizedCode = /^[0-9.\s]+$/.test(cleaned) ? cleaned.replace(/[.\s]/g, "") : "";
  const empty = !cleaned;
  const formatValid = empty || /^(?:\d{6}|\d{8}|\d{10})$/.test(normalizedCode);
  const hs6 = formatValid && !empty ? normalizedCode.slice(0, 6) : "";
  let matchLevel = empty ? "empty" : "unknown";
  let options = [];
  const warnings = [];
  if (empty) return { rawCode, normalizedCode: "", hs6: "", formatValid, matchLevel, ambiguous: false, options, warnings };
  if (!formatValid) {
    warnings.push("原码需人工核对：网页找客仅接受可明确识别的 6、8 或 10 位数字；不补零、不修复科学计数法。原始资料仍保留原值。");
    return { rawCode, normalizedCode, hs6, formatValid, matchLevel, ambiguous: false, options, warnings };
  }
  options = COMPANY_HS_CATALOG.filter(item => item.companyCode === normalizedCode);
  if (options.length) matchLevel = "company_code";
  else {
    options = COMPANY_HS_CATALOG.filter(item => item.companyCode.startsWith(normalizedCode));
    if (options.length) matchLevel = normalizedCode.length === 6 ? "hs6" : "company_prefix";
    else {
      options = COMPANY_HS_CATALOG.filter(item => item.companyCode.startsWith(hs6));
      if (options.length) { matchLevel = "hs6"; warnings.push("该完整编号不在企业提供的原码清单中；仅按相同前 6 位提示可能品类，完整码含义仍待核对。"); }
    }
  }
  warnings.push("品类提示来自冠英提供的 Q&A 原码清单，未核对各国税则或年度版本；HS 不确认具体 SKU、适配或采购需求。");
  if (options.length > 1) warnings.push("这个范围覆盖多个企业品类，必须手动选择本轮品类，不能由 HS 唯一确定。");
  if (!options.length) warnings.push("企业参考清单没有该码对应的品类；请结合产品材料手动确认，系统不猜测映射。");
  if (options.length && options.every(item => !item.supported)) warnings.push("企业清单指向离合器面片，当前网页找客只支持三类制动件，不能转成刹车片搜索。");
  return { rawCode, normalizedCode, hs6, formatValid, matchLevel, ambiguous: options.length > 1, options: options.map(item => ({ ...item })), warnings };
}
