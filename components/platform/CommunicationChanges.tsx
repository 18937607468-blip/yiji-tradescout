"use client";

import { FormEvent, useEffect, useState } from "react";
import { Check, CheckCircle2, ChevronDown, GitCompareArrows, Pause, Plus, Quote } from "lucide-react";
import { Company, STAGES, formatDate } from "./types";
import { Button } from "./PlatformUI";
import { Mutation } from "./CompanyForms";

const NAMES: Record<string, string> = { productRefs: "产品需求", buyerRole: "买家角色", nextAction: "下一步行动", stage: "跟进阶段", lossReason: "本次未推进原因" };
const valueText = (value: unknown) => Array.isArray(value) ? value.join("、") || "未记录" : value && typeof value === "object" ? JSON.stringify(value) : String(value || "未记录");

export default function CommunicationChanges({ company, busy, onAction }: { company: Company; busy: string; onAction: Mutation }) {
  const [open, setOpen] = useState(false);
  const [localError, setLocalError] = useState("");
  const [sourceId, setSourceId] = useState(company.communications?.at(-1)?.id || "");
  const [formRevision, setFormRevision] = useState(company.revision);
  const [deferredIds, setDeferredIds] = useState<string[]>([]);
  const [applyingId, setApplyingId] = useState("");
  const [appliedId, setAppliedId] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  useEffect(() => {
    if (!appliedId) return;
    const timer = window.setTimeout(() => setAppliedId(""), 2400);
    return () => window.clearTimeout(timer);
  }, [appliedId]);
  const communications = company.communications || [];
  const proposals = company.memoryProposals || [];
  const selectedSource = communications.find(item => item.id === sourceId);
  const changedElsewhere = open && formRevision !== company.revision;
  const beginProposal = () => {
    setLocalError(""); setActionNotice(""); setSourceId(communications.at(-1)?.id || "");
    setFormRevision(company.revision); setOpen(true);
  };
  const applyProposal = async (proposalId: string) => {
    if (busy || applyingId) return;
    setLocalError(""); setActionNotice(""); setApplyingId(proposalId);
    try {
      await onAction("apply_memory", { companyId: company.id, proposalId });
      setAppliedId(proposalId);
      setActionNotice("服务端已确认保存。客户资料已更新，原话和修改前的记录仍然保留。");
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "尚未确认保存，请核对当前记录后再操作。");
    } finally { setApplyingId(""); }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (changedElsewhere) { setLocalError("客户资料已更新。请先保留当前填写内容，收起后重新核对最新资料。"); return; }
    const data = new FormData(event.currentTarget);
    const sourceId = String(data.get("communicationId") || "");
    const source = communications.find(item => item.id === sourceId);
    const proposed: Record<string, unknown> = {
      productRefs: String(data.get("productRefs") || "").split(/[,，;；\n]+/).map(x => x.trim()).filter(Boolean),
      buyerRole: String(data.get("buyerRole") || "").trim(),
      nextAction: String(data.get("nextAction") || "").trim(),
      stage: String(data.get("stage") || "待研究"),
      lossReason: String(data.get("lossReason") || "").trim(),
    };
    const current: Record<string, unknown> = { productRefs: company.productRefs || [], buyerRole: company.buyerRole || "", nextAction: company.nextAction || "", stage: company.stage || "待研究", lossReason: company.lossReason || "" };
    const patch = Object.fromEntries(Object.entries(proposed).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key])));
    if (!Object.keys(patch).length) { setLocalError("没有资料变化。请修改需要更新的字段，再提出更新。"); return; }
    if (!source?.occurredAt) { setLocalError("该沟通缺少发生时间，请先保存一条日期明确的沟通记录。"); return; }
    setLocalError("");
    try {
      await onAction("propose_memory", {
        companyId: company.id, communicationId: sourceId || undefined, occurredAt: source?.occurredAt,
        reason: String(data.get("reason") || "").trim(),
        patch,
      });
      setOpen(false);
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : "未能保存待确认变化，输入内容已保留。"); }
  };
  return <section className="ts-memory-section ts-memory-workbench">
    <div className="ts-section-heading"><h3><GitCompareArrows size={17} />客户记忆，有据更新</h3>{!open && <button className="ts-text-button" onClick={beginProposal} disabled={!communications.length || !!busy}><Plus size={14} />提出资料更新</button>}</div>
    <p className="ts-memory-caption">先对照原话提出变化，再由你确认。这里更新客户的一般资料；询价数量、适配关系和订单仍需在对应流程核对。</p>
    <div className="ts-memory-process" aria-label="客户资料更新流程"><span><b>1</b>找到沟通原话</span><span><b>2</b>核对前后变化</span><span><b>3</b>人工确认保存</span></div>
    {!communications.length && <p className="ts-form-note">先保存一段沟通，再提出有依据的资料更新。</p>}
    {actionNotice && <p className="ts-memory-status" role="status">{actionNotice}</p>}
    {localError && <p className="ts-inline-error" role="alert">{localError}</p>}
    {open && <form onSubmit={submit} className="ts-proposal-form">
      <label className="ts-field">依据哪一条沟通<select name="communicationId" required value={sourceId} onChange={event => setSourceId(event.target.value)}>{[...communications].reverse().map(item => <option key={item.id} value={item.id}>{item.occurredAt ? formatDate(item.occurredAt, true) : "发生时间未知"} · {item.text.slice(0, 45)}</option>)}</select></label>
      {selectedSource && <div className="ts-memory-selected-source"><span><Quote size={13} />本次依据的原话{selectedSource.dataClass === "synthetic" && <em>演示样例</em>}</span><blockquote>{selectedSource.text}</blockquote><small>{selectedSource.occurredAt ? `沟通发生于 ${formatDate(selectedSource.occurredAt, true)}（北京时间）` : "发生时间未知：先补存日期明确的沟通，再提出更新。"}</small></div>}
      <label className="ts-field">产品需求 / 编号<input name="productRefs" defaultValue={company.productRefs?.join(", ")} placeholder="仅填写原话中可以确认的型号" /></label>
      <label className="ts-field">买家角色<input name="buyerRole" defaultValue={company.buyerRole} placeholder="未知可留空" /></label>
      <label className="ts-field">下一步行动<input name="nextAction" defaultValue={company.nextAction} placeholder="例如：确认客户可接受的订单量" /></label>
      <label className="ts-field">跟进阶段<select name="stage" defaultValue={company.stage || "待研究"}>{STAGES.map(stage => <option key={stage}>{stage}</option>)}</select></label>
      <label className="ts-field">本次未推进原因（如有）<input name="lossReason" defaultValue={company.lossReason} placeholder="仅记录该客户已表达的障碍，不推广到整个市场" /></label>
      <label className="ts-field">更新依据<textarea name="reason" rows={2} required placeholder="原称呼 → 确认编号 / 规格；适用市场、年份与标准版本；原文来源；仍未确认的事项。" /></label>
      {changedElsewhere && <p className="ts-inline-error" role="alert">客户资料已有新版本。请先保留填写内容，收起后重新打开，避免覆盖新记录。</p>}
      <p className="ts-memory-form-note">提出变化不会立即改资料。收起只结束本次填写，原记录不会改变。</p>
      <div className="ts-proposal-actions"><Button type="button" disabled={!!busy} onClick={() => { setLocalError(""); setOpen(false); }}>收起，不提出更新</Button><Button type="submit" variant="primary" busy={busy === "propose_memory"} disabled={!!busy || changedElsewhere || !selectedSource?.occurredAt}>生成待确认变化</Button></div>
    </form>}
    {[...proposals].reverse().map(proposal => {
      const deferred = proposal.status === "pending" && deferredIds.includes(proposal.id);
      const recent = proposal.status === "applied" && appliedId === proposal.id;
      return <article className={`ts-proposal-card ts-memory-proposal ${proposal.status} ${recent ? "just-applied" : ""}`} key={proposal.id}>
        <div className="ts-proposal-header"><strong>{proposal.status === "applied" ? <><CheckCircle2 size={15} />人工确认 · 已应用</> : proposal.status === "cancelled" ? "已取消 · 未应用" : proposal.status === "stale" ? "历史变化 · 未应用" : deferred ? <><Pause size={14} />暂缓核对 · 尚未应用</> : "待你确认的变化"}</strong><span>{proposal.createdAt ? formatDate(proposal.createdAt, true) : "提出时间未记录"}</span></div>
        {deferred ? <div className="ts-memory-deferred"><p>原记录没有改变，待确认变化仍保留。暂缓仅收起本次显示，不会删除记录。</p><Button onClick={() => setDeferredIds(ids => ids.filter(id => id !== proposal.id))}><ChevronDown size={14} />继续核对</Button></div> : <>
          <div className="ts-memory-source-label"><Quote size={13} />这次变化依据的沟通原话</div>
          {proposal.sourceText ? <blockquote><span>{proposal.sourceText}</span></blockquote> : <p className="ts-form-note">历史记录未保存可展示的原话，请重新核对来源。</p>}
          <div className="ts-proposal-times"><span>沟通发生 {proposal.occurredAt ? formatDate(proposal.occurredAt, true) : "时间未知"}</span><span>提出更新 {proposal.createdAt ? formatDate(proposal.createdAt, true) : "时间未知"}</span>{proposal.appliedAt && <span>确认保存 {formatDate(proposal.appliedAt, true)}</span>}<span>北京时间</span></div>
          <div className="ts-memory-diff-table" role="table" aria-label="客户资料更新对照">
            <div className="ts-memory-diff-head" role="row"><span role="columnheader">原记录</span><span role="columnheader">本次拟更新</span><span role="columnheader">确认结果</span></div>
            {Object.keys(proposal.after || {}).filter(key => key in NAMES).map(key => <div className="ts-memory-diff-group" key={key}><strong>{NAMES[key]}</strong><div className="ts-memory-diff-row" role="row"><span role="cell" data-label="原记录">{valueText(proposal.before?.[key])}</span><span role="cell" data-label="本次拟更新">{valueText(proposal.after?.[key])}</span><span role="cell" data-label="确认结果" className={proposal.status === "applied" ? "is-confirmed" : "is-awaiting"}>{proposal.status === "applied" ? <><Check size={13} />{valueText(proposal.after?.[key])}<small>本次确认时保存的值</small></> : ["stale", "cancelled"].includes(proposal.status) ? <>未写入<small>保留原资料</small></> : <>尚未应用<small>确认后才写入资料</small></>}</span></div></div>)}
          </div>
          {proposal.reason && <p className="ts-proposal-reason"><strong>人工说明</strong>{proposal.reason}</p>}
          {proposal.status === "pending" && <div className="ts-memory-confirm-actions"><Button disabled={!!busy || !!applyingId} onClick={() => { setDeferredIds(ids => [...ids, proposal.id]); setActionNotice("已暂缓本次核对，未应用变化。原记录和待确认变化都保留。"); }}><Pause size={14} />暂缓，不应用</Button><Button disabled={!!busy || !!applyingId} onClick={async () => { try { await onAction("cancel_memory", { companyId: company.id, proposalId: proposal.id }); setActionNotice("已取消该更新，客户原资料未改变。"); } catch (cause) { setLocalError(cause instanceof Error ? cause.message : "取消未成功。"); } }}>取消这次更新</Button><Button variant="primary" disabled={!!busy || !!applyingId} busy={applyingId === proposal.id} onClick={() => { void applyProposal(proposal.id); }}><Check size={15} />核对无误，确认应用</Button></div>}
          {proposal.status === "applied" && <small className="ts-applied-note">{recent ? "刚刚保存成功。" : "这是该次确认的历史记录。"}原话、原值与确认结果均保留；之后的修改不会被这条记录覆盖。</small>}
          {proposal.status === "stale" && <small className="ts-applied-note">此记录时间较旧，不能覆盖较新的资料，请根据新沟通重新确认。</small>}
        </>}
      </article>;
    })}
    {company.nextScreeningSuggestion?.text && <div className="ts-next-screening"><strong>下一轮筛选建议 · 待人工审核</strong><p>{company.nextScreeningSuggestion.text}</p><small>可在“提出更新”中修订本次未推进原因；其他企业仍需分别核验。</small></div>}
  </section>;
}
