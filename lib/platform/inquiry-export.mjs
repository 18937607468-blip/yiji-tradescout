function cell(value) {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function inquiryCsv(state) {
  const headers = ["询价编号", "客户", "资料类型", "来源渠道", "询价原文", "车型（辅助）", "车桥品牌", "车桥型号", "车桥制造年份", "制动器", "原件编号体系", "原件编号", "片型", "厚度mm", "目录宽度原值", "材质", "数量", "数量单位", "币种", "贸易条件", "目的地", "候选总数", "展示候选件号", "候选依据", "待确认条件", "价格状态", "历史参考价（非正式报价）", "负责人", "下次核对", "记录版本", "更新时间"];
  const rows = (state.inquiries || []).map(inquiry => {
    const input = inquiry.inputs || {}, result = inquiry.analysis || {};
    const company = state.companies.find(item => item.id === inquiry.companyId);
    const quotes = (result.quoteRanges || []).map(q => `${q.namespace} ${q.partNumber}: ${q.min}–${q.max} ${q.currency}/${q.unit}; ${q.incoterm}; ${q.sourceTitle}; 有效至 ${q.validUntil}`).join(" | ");
    return [inquiry.id, company?.name || "", inquiry.dataClass === "synthetic" ? "演示资料" : "真实询价", inquiry.channel, inquiry.sourceText, input.vehicleModel, input.axleBrand, input.axleModel, input.year, input.brakeSystem, input.codeNamespace, input.partCode, input.partType, input.thicknessMm, input.rawWidth, input.materialGrade, input.quantity, input.unit, input.currency, input.incoterm, input.destination, result.totalCandidates, (result.candidates || []).map(c => `${c.namespace} ${c.partNumber} [${c.status === "confirmed" ? "人工核准限定配置" : "待核适配"}]`).join(" | "), (result.candidates || []).flatMap(c => (c.evidence || []).map(e => `${c.partNumber}: ${e.title} ${e.page || ""} ${e.url || ""}`)).join(" | "), (result.missing || []).join(" | "), result.quoteStatus === "reference_available" ? "历史参考价" : "待企业核价", quotes, inquiry.owner, inquiry.nextFollowUpAt, inquiry.revision, inquiry.updatedAt];
  });
  return "\uFEFF" + [headers, ...rows].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
