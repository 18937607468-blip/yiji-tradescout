"use client";

import { useMemo, useRef, useState } from "react";
import { Check, ClipboardCopy, FilePenLine, HandHeart, RefreshCw } from "lucide-react";
import type { InquiryAnalysis, InquiryInputs } from "./inquiry-types";
import "./CustomerCareReply.css";

type Concern = "fit" | "urgent" | "price";
type Props = { inputs: InquiryInputs; analysis: InquiryAnalysis | null; stale: boolean; disabled?: boolean; contextKey: string };
const concise = (value: unknown) => String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 180);
const present = (value: unknown) => !!concise(value);

/** Drafting is deliberately deterministic; catalogue decisions remain in the matching engine. */
function nextQuestion(inputs: InquiryInputs, analysis: InquiryAnalysis): string {
  const candidates = analysis.candidates || [];
  const thicknesses = [...new Set(candidates.filter(candidate => candidate.dimensions?.unit === "mm").map(candidate => concise(candidate.dimensions?.thickness)).filter(Boolean))];
  const widths = [...new Set(candidates.map(candidate => concise(candidate.dimensions?.width)).filter(Boolean))];
  if (analysis.status === "conflict") return "Could you check the axle model and manufacturing year against the identification plate on the current axle?";
  if (thicknesses.length > 1 && !present(inputs.thicknessMm)) return `Could you confirm the lining thickness from the old part or drawing: ${thicknesses.join(", ")} mm?`;
  if (widths.length > 1 && !present(inputs.rawWidth) && (!present(inputs.widthMm) || !inputs.dimensionUnitConfirmed)) return "Could you share the lining width exactly as shown in your drawing, including its unit?";
  if (!present(inputs.axleModel) && !(present(inputs.partCode) && inputs.codeNamespace !== "unknown")) return inputs.photoUrl ? "Which axle model is shown on the identification plate in the photo you shared?" : "Could you send a clear photo of the identification plate on the current axle?";
  if (inputs.partType === "unknown") return "Are you looking for a drum brake lining, a disc brake pad or a complete brake shoe?";
  if (present(inputs.axleModel) && !present(inputs.brakeSystem) && !present(inputs.partCode)) return "Could you confirm the brake system model fitted to this axle?";
  if (thicknesses.length && !present(inputs.thicknessMm) && !present(inputs.rawThickness)) return "Could you confirm the lining thickness shown in the old-part specification or drawing?";
  if (candidates.some(candidate => candidate.kind === "company") && (present(inputs.rawWidth) || present(inputs.rawThickness)) && !inputs.dimensionUnitConfirmed) return "Could you confirm the measurement unit used in the product drawing?";
  if (!present(inputs.materialGrade)) return "Which material or performance specification does your current part use?";
  if (!present(inputs.accessories)) return "Should the quotation include rivets or any other accessories?";
  if (!present(inputs.quantity)) return "What quantity should we use for this quotation?";
  if (!present(inputs.unit)) return "Should the quotation be calculated per lining, per set or on another unit basis?";
  if (!present(inputs.incoterm)) return "Which trade terms should we use for the quotation?";
  if (!present(inputs.destination)) return "Which destination or agreed port should we use for the quotation?";
  if (!present(inputs.currency)) return "Which currency should we use for the quotation?";
  return "Would you like our team to prepare a quotation using the specification and trade terms already recorded?";
}

export function composeCareReply(inputs: InquiryInputs, analysis: InquiryAnalysis, concern: Concern, replyBy: string): string {
  const axle = [concise(inputs.axleBrand), concise(inputs.axleModel)].filter(Boolean).join(" ");
  const identification = axle ? `your enquiry about the ${axle} axle` : present(inputs.partCode) ? `your enquiry about part ${concise(inputs.partCode)}` : "the details of your brake-part enquiry";
  const acknowledgement: Record<Concern, string> = {
    fit: "I understand that getting the correct part matters to you.",
    urgent: "I understand that this enquiry is time-sensitive for you.",
    price: "I understand that you want a clear price and a clear explanation of what it includes.",
  };
  const candidates = analysis.candidates || [];
  const companyCandidates = candidates.filter(candidate => candidate.kind === "company");
  const originalOnly = !!candidates.length && candidates.every(candidate => candidate.kind === "oem");
  const confirmedCompany = candidates.some(candidate => candidate.kind === "company" && candidate.status === "confirmed");
  let finding = "The available catalogue evidence does not yet establish a matching part for these details.";
  if (originalOnly) {
    const refs = candidates.slice(0, 3).map(candidate => concise(candidate.partNumber)).join(", ");
    finding = `The catalogue check retains original-manufacturer reference${candidates.length > 1 ? "s" : ""} ${refs}; a KOOYING replacement still needs to be verified.`;
  } else if (confirmedCompany) {
    finding = "Our saved record includes a technician-confirmed part relationship for this configuration; availability and the final quotation still need checking.";
  } else if (companyCandidates.length) {
    finding = `The current check includes ${companyCandidates.length} KOOYING catalogue candidate${companyCandidates.length > 1 ? "s" : ""}, with fitment and any original-manufacturer cross-reference still to be verified.`;
  }
  const question = nextQuestion(inputs, analysis);
  let nextStep = "Our team will verify the remaining details and explain the part choice and quotation basis before you decide.";
  if (concern === "price" && !analysis.quoteRanges?.length) nextStep = "Our team will check the part match, material and accessory scope, so the quotation makes clear what is included.";
  if (concern === "price" && analysis.quoteRanges?.length) nextStep = "There is a historical price reference for the recorded conditions; our team will check it before confirming a quotation and what it includes.";
  if (concern === "urgent") nextStep = "Our team will check the remaining specification and availability before confirming the next step or a delivery date.";
  const commitment = concise(replyBy) ? ` Our team will send you an update by ${concise(replyBy)}.` : "";
  return `Thank you for ${identification}. ${acknowledgement[concern]}\n\n${finding} ${question}\n\n${nextStep}${commitment}`;
}

export default function CustomerCareReply({ inputs, analysis, stale, disabled, contextKey }: Props) {
  const [concern, setConcern] = useState<Concern | "">("");
  const [replyBy, setReplyBy] = useState("");
  const [commitmentConfirmed, setCommitmentConfirmed] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftBasis, setDraftBasis] = useState("");
  const [edited, setEdited] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [notice, setNotice] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const basis = useMemo(() => JSON.stringify({ inputs, analysis, concern, replyBy, commitmentConfirmed, contextKey }), [inputs, analysis, concern, replyBy, commitmentConfirmed, contextKey]);
  const outdated = !!draft && (stale || basis !== draftBasis);
  const canGenerate = !!analysis && !stale && !!concern && !disabled && (!replyBy.trim() || commitmentConfirmed);
  const generate = (replaceConfirmed = false) => {
    if (!canGenerate || !analysis || !concern) return;
    if (edited && !replaceConfirmed) { setConfirmReplace(true); return; }
    setDraft(composeCareReply(inputs, analysis, concern, replyBy)); setDraftBasis(basis); setEdited(false); setConfirmReplace(false); setNotice("草稿已生成。请核对英文和承诺内容后再复制发送。");
  };
  const copy = async () => {
    if (!draft || outdated || disabled) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(draft); setNotice("英文草稿已复制，尚未发送；客户回复状态没有改变。");
    } catch {
      textarea.current?.focus(); textarea.current?.select(); setNotice("无法自动复制，已选中草稿文字，请手动复制。");
    }
  };
  return <section className="care-panel" aria-label="客户关怀回复草稿">
    <header className="care-head"><div className="care-heading"><span className="care-icon"><HandHeart size={23} /></span><div><h2>让客户少操心</h2><p>记住客户已经给出的信息，只补问最关键的一项。</p></div></div><span className="care-label">人工审核草稿 · 尚未发送</span></header>
    <div className="care-layout"><div className="care-controls"><label className="care-field"><span>客户明确表达的顾虑</span><select value={concern} onChange={event => { setConcern(event.target.value as Concern | ""); setNotice(""); setConfirmReplace(false); }}><option value="">按客户实际表达选择</option><option value="fit">担心买错</option><option value="urgent">急需处理</option><option value="price">关心价格</option></select></label>
      <label className="care-field"><span>答复时间与时区 <small>选填</small></span><input value={replyBy} maxLength={120} onChange={event => { setReplyBy(event.target.value); setCommitmentConfirmed(false); setNotice(""); setConfirmReplace(false); }} placeholder="如 21 Nov, 18:00 (UTC+8)" /><small>填写后会加入承诺句；请使用客户能理解的日期、时间及时区。</small></label>
      {replyBy.trim() && <label className="care-confirm"><input type="checkbox" checked={commitmentConfirmed} onChange={event => setCommitmentConfirmed(event.target.checked)} /><span>销售已确认团队能在这个时间给出更新。</span></label>}
      <button className="care-button care-primary" onClick={() => generate()} disabled={!canGenerate}><FilePenLine size={16} />{draft ? "重新生成英文草稿" : "生成英文回复草稿"}</button>
      <p className="care-method">规则生成 · 使用已核对字段 · 不调用模型。{!analysis || stale ? "请先完成当前条件的目录核验。" : !concern ? "请先选择客户已表达的顾虑。" : "请核对后用于实际沟通。"}</p>
      <div className="care-next"><Check size={15} /><p>下一步建议：保留已知规格；寄样或成交后再确认收货与试装反馈。<span>尚未自动安排或发送。</span></p></div>
    </div><div className={`care-editor ${outdated ? "care-outdated" : ""}`}>
      <div className="care-editor-head"><strong>英文回复</strong><span>{edited ? "已人工编辑" : "可在发送前修改"}</span></div>
      <textarea ref={textarea} aria-label="英文客户回复草稿" rows={11} value={draft} onChange={event => { setDraft(event.target.value); setEdited(true); setNotice(""); }} placeholder="先完成目录核验，再生成简短、具体、有下一步的英文草稿。" spellCheck={false} />
      {outdated && <p className="care-stale" role="status"><RefreshCw size={15} />条件或沟通安排已变化，旧草稿不可复制，请重新生成并核对。</p>}
      {confirmReplace && <div className="care-replace"><p>重新生成会替换这份人工修改，是否继续？</p><div><button className="care-button" onClick={() => setConfirmReplace(false)}>保留人工修改</button><button className="care-button care-primary" onClick={() => generate(true)} disabled={!canGenerate}>确认替换并生成</button></div></div>}
      <div className="care-editor-footer"><span>供货、适配和交期均以实际核准结果为准</span><button className="care-button" onClick={copy} disabled={!draft.trim() || outdated || disabled}><ClipboardCopy size={16} />复制英文草稿</button></div>
      {notice && <p className="care-notice" role="status">{notice}</p>}
    </div></div>
  </section>;
}
