// Conservative evidence gates. These establish research leads, never fitment or buyer intent.
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const compact = value => String(value || "").replace(/\s+/g, " ").trim();
const commercialVehicles = /\b(?:commercial vehicles?|heavy[- ]duty vehicles?|heavy goods vehicles?|trucks?|lorr(?:y|ies)|buses|bus|trailers?|HGVs?)\b|商用车|重型车|卡车|货车|客车|巴士|挂车/i;
const categories = {
  brake_lining: /\b(?:brake|friction) linings?\b|制动衬片|刹车衬片|鼓式刹车片|鼓式制动片/i,
  disc_brake_pad: /\b(?:disc[- ]?)?brake pads?\b|\bdisc pads?\b|盘式刹车片|盘式制动片/i,
  brake_shoe: /\bbrake shoes?\b|制动蹄|刹车蹄/i,
};
const brands = ["SAF-HOLLAND", "SAF", "BPW", "MERITOR", "KNORR-BREMSE", "KNORR", "WABCO", "HALDEX", "BREMBO", "TEXTAR", "TRW", "MAN", "VOLVO", "SCANIA", "DAF", "IVECO", "MERCEDES", "RENAULT"];
export const SCREENING_VERSION = "b2b-evidence-v3-role";

function labelledCode(text, label, value) {
  const number = escapeRegex(value);
  const qualifiers = "(?:\\s*(?:code|number|no\\.?|ref\\.?|reference))?";
  return new RegExp("(?:^|[^A-Za-z0-9])(?:" + label + ")" + qualifiers + "[\\s:#=.,()/-]{0,12}" + number + "(?![A-Za-z0-9]|[./-][A-Za-z0-9])", "i").test(text)
    || new RegExp("(?:^|[^A-Za-z0-9])" + number + "[\\s:(),/-]{0,8}(?:" + label + ")(?=$|[^A-Za-z0-9])", "i").test(text);
}

function codeContextMatches(quote, code, product) {
  if (code.namespace === "WVA") return labelledCode(quote, "WVA", code.value);
  if (code.namespace !== "OE") return false;
  if (labelledCode(quote, "O\\.?E\\.?(?:M)?", code.value)) return true;
  // A WVA/internal identifier must not become an OE identifier merely through equal digits.
  if (labelledCode(quote, "WVA|INTERNAL", code.value)) return false;
  const productBrands = brands.filter(brand => new RegExp("\\b" + escapeRegex(brand) + "\\b", "i").test(product.name));
  const hasSameBrand = productBrands.some(brand => new RegExp("\\b" + escapeRegex(brand) + "\\b", "i").test(quote));
  return hasSameBrand && labelledCode(quote, "ref(?:erence)?\\.?|part|article", code.value);
}

function nearbyText(match, sources) {
  const text = compact(sources.find(source => source.id === match.sourceId)?.snippet);
  const quote = compact(match.quote);
  const position = text.indexOf(quote);
  return position < 0 ? quote : text.slice(Math.max(0, position - 220), position + quote.length + 220);
}

export function assessProductMatch(match, product, sources) {
  const prefix = product.name + "：";
  const context = nearbyText(match, sources);
  if (/non[- ]commercial|not for commercial|非商用|不适用于商用车/i.test(context)
      || (/passenger[- ]?(?:cars?|vehicles?)|乘用车|轿车/i.test(context) && (!commercialVehicles.test(context) || /\bonly\b|exclusively|专用|仅供/i.test(context)))) {
    return { accepted: false, reason: prefix + "原文出现乘用车专用或非商用用途，不能凭同编号确认为目标产品，留待核验。" };
  }
  const targetCategory = categories[product.category];
  if (match.relationship === "same_code" && targetCategory && !targetCategory.test(match.quote)
      && Object.entries(categories).some(([category, pattern]) => category !== product.category && pattern.test(match.quote))) {
    return { accepted: false, reason: prefix + "同编号原句中的制动品类与产品资料冲突，不能把制动蹄、衬片或盘式片视为同一配件，留待核验。" };
  }
  if (/\b(?:discontinued|obsolete|incompatible|superseded)\b|out of production|(?:does|do|will) not fit|not (?:compatible|suitable|applicable)|no longer (?:valid|produced)|replaced by|停产|不适配|不兼容|不适用|已废止|年款不符|年份冲突|版本冲突/i.test(context)) {
    return { accepted: false, reason: prefix + "原文出现停产、不适配或版本冲突线索，保留待核验；未确认兼容性。" };
  }
  if (/(?:do(?:es)? not|never|no longer) (?:sell|supply|manufacture|stock|distribute)|不(?:销售|经营|供应|生产)/i.test(context)) {
    return { accepted: false, reason: prefix + "原文含不销售或不供应的否定描述，不能作为正向产品经营证据。" };
  }
  if (/\b(?:19|20)\d{2}\b/.test(context) && /model[- ]?years?|fits? only|up to|before|after|until|年款|仅适用|以前|以后|\b(?:ISO|SAE|ECE|UNECE)\b|GB\/T|国标/i.test(context)) {
    return { accepted: false, reason: prefix + "原文含年款范围或适用年份条件，尚未与客户需求核对，不据此提高等级。" };
  }
  if (match.relationship === "same_code") {
    const supportedCode = product.codes.some(code => ["OE", "WVA"].includes(code.namespace) && codeContextMatches(match.quote, code, product));
    return supportedCode
      ? { accepted: true }
      : { accepted: false, reason: prefix + "仅数字相同不足以建立同编号线索；需原文 WVA/OE 标识，或与产品一致的品牌及零件编号上下文。HS、企业内部号不能替代。" };
  }
  const category = categories[product.category];
  return category && commercialVehicles.test(match.quote) && category.test(match.quote)
    ? { accepted: true }
    : { accepted: false, reason: prefix + "缺少同一原文中的商用车用途和具体制动品类证据，相关类别暂待核验。" };
}

export function hasBuyerRoleEvidence(facts, sources) {
  return facts.some(fact => {
    if (!["buyer_role", "business_activity"].includes(fact.field)) return false;
    const quote = compact(fact.quote);
    const source = sources.find(item => item.id === fact.sourceId);
    if (!source || !quote || !compact(source.snippet).includes(quote)) return false;
    // References to a supplier's customers do not establish the supplier's own buying role.
    if (/\b(?:customers?|clients?|partners?|suppliers?)\b|(?:supply|supplies|sell|sells) to|for (?:importers?|distributors?|wholesalers?)|(?:not|no longer|formerly) (?:an? )?(?:importer|distributor|wholesaler)|客户|供应给|不是进口商|并非经销商/i.test(quote)) return false;
    return /\b(?:importers?|distributors?|wholesalers?|purchasing department|procurement team)\b|\bwe (?:also |directly )?(?:import|distribute|wholesale|purchase|buy)\b|进口商|经销商|分销商|批发商|进口业务|我们(?:进口|采购)|我司(?:进口|采购)/i.test(quote);
  });
}

export function researchGradeFor(matches, facts = [], sources = []) {
  return matches.length && hasBuyerRoleEvidence(facts, sources) ? "B" : "unknown";
}
