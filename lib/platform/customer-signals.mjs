// Browser-safe literal evidence rules. Original text is data, never an instruction.
export function detectCustomerSignals(sourceText) {
  if (typeof sourceText !== "string") return [];
  const sentences = sourceText.slice(0, 20000).match(/[^.!?。！？\n]+[.!?。！？]?/g) || [];
  const rules = [
    { kind: "urgent", label: "急需处理", match: /\burgent(?:ly)?\b|\basap\b|\bas soon as possible\b|\bneed\b.{0,30}\btoday\b|急需|急用|尽快|紧急|今天.{0,10}(?:要|需)/i,
      negation: /\b(?:not|no|never|don't|doesn't|isn't|aren't)\b.{0,45}\b(?:urgent|urgently|rush|hurry|asap|today)\b|\bno rush\b|不.{0,6}(?:急|尽快)|无需.{0,6}(?:急|尽快)|不用.{0,6}(?:急|尽快)/i },
    { kind: "price", label: "关注价格", match: /\bdiscount\b|\btoo expensive\b|\bseems?\s+expensive\b|\bprice\b.{0,15}\b(?:high|lower|best|expensive)\b|\b(?:best|lower|better)\s+price\b|\bover.{0,8}budget\b|价格.{0,8}(?:高|贵|优惠)|降价|折扣|优惠|预算不足|太贵/i,
      negation: /\b(?:not|no|don't|doesn't|isn't)\b.{0,30}\b(?:expensive|discount|high|price|budget)\b|不.{0,8}(?:贵|降价|折扣|优惠|预算)|无需.{0,8}(?:优惠|折扣)/i },
    { kind: "delivery", label: "关注交期", match: /\bconfirm\b.{0,30}\b(?:dispatch timing|delivery date|dispatch date|shipping date|delivery time|lead time)\b|\b(?:worried|concerned|worry)\b.{0,60}\b(?:delivery|lead time|dispatch|shipping|delay)\b|\b(?:delivery|lead time)\b.{0,20}\btoo long\b|担心.{0,20}(?:交期|发货|交货|延误)|交期.{0,8}太长|能否.{0,10}按时.{0,8}(?:发货|交货)|怕.{0,8}延误/i,
      negation: /\b(?:not|no|don't|doesn't|isn't)\b.{0,30}\b(?:worried|concerned|worry|long|delay|confirm|delivery date|dispatch timing)\b|不.{0,6}(?:担心|怕|着急)|无需.{0,6}担心/i },
    { kind: "decision", label: "尚在决策", match: /\bstill (?:deciding|considering|evaluating)\b|\bneed (?:to|more time to) (?:compare|decide|discuss)\b|\bawaiting approval\b|还在(?:考虑|比较|决策)|需要.{0,8}(?:比较|讨论|审批)|等待.{0,8}(?:批准|审批)|尚未决定/i,
      negation: /\b(?:not|no|don't)\b.{0,30}\b(?:deciding|considering|evaluating|compare|decide|discuss|approval)\b|不需要.{0,8}(?:比较|讨论|审批)|已经决定|已决定/i },
  ];
  const result = [], seen = new Set();
  for (const raw of sentences) {
    const quote = raw.trim();
    const checkText = quote.replace(/[’‘]/g, "'");
    if (!quote || quote.length > 1500 || /\b(?:if|maybe|perhaps|might|possibly)\b|\bnot sure\b|如果|假如|也许|可能|不确定/i.test(checkText)) continue;
    for (const rule of rules) {
      if (!rule.match.test(checkText) || rule.negation.test(checkText)) continue;
      const key = rule.kind + "\n" + quote;
      if (seen.has(key)) continue;
      seen.add(key); result.push({ label: rule.label, kind: rule.kind, quote, method: "rule", status: "pending_review" });
    }
  }
  return result.slice(0, 12);
}
