"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowUpRight, CalendarDays, CheckCircle2, Clock3, Copy, FileText, Globe2, Mail, MessageSquare, Pencil, Search, ShieldCheck, UserRound, X } from "lucide-react";
import { Company, PlatformEvent, PlatformState, formatDate, hostname, isDemoCompany, isOverdue, safeUrl } from "./types";
import { Button, CompanyAvatar, EmptyState, ExternalLink, GradeBadge } from "./PlatformUI";
import { Mutation } from "./CompanyForms";
import CommunicationChanges from "./CommunicationChanges";
import CompanyWebsiteResolver from "./CompanyWebsiteResolver";
import "./CustomerDetail.css";

export default function CompanyDrawer({ company, events, onClose, onEdit, onResearch, onFinancialReview, onFindBuyers, onUpdated, onAction, busy, error, modelConfigured }: {
  company: Company; events: PlatformEvent[]; onClose: () => void; onEdit: () => void;
  onResearch: (company: Company) => Promise<void>; onFinancialReview?: () => void; onFindBuyers?: () => void; onUpdated?: (state: Partial<PlatformState>) => void; onAction: Mutation; busy: string; error?: string; modelConfigured: boolean;
}) {
  const [tab, setTab] = useState<"overview" | "evidence" | "communication">("overview");
  const [text, setText] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [dataClass, setDataClass] = useState<"real" | "synthetic">("real");
  const [messageError, setMessageError] = useState("");
  const [websiteResolverOpen, setWebsiteResolverOpen] = useState(false);
  const [websiteNotice, setWebsiteNotice] = useState("");
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => { setTab("overview"); setText(""); setOccurredAt(""); setDataClass("real"); setMessageError(""); setWebsiteResolverOpen(false); setWebsiteNotice(""); }, [company.id]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    root.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (document.querySelector(".ts-modal-layer")) return;
      if (event.key === "Escape") close.current();
      if (event.key === "Tab") {
        const items = root.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  const saveMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy || !text.trim()) return; setMessageError("");
    const submittedOccurredAt = String(new FormData(event.currentTarget).get("occurredAt") || "").trim();
    if (submittedOccurredAt && !Number.isFinite(Date.parse(submittedOccurredAt))) { setMessageError("请填写有效的沟通发生时间，或留空标记未知。"); return; }
    try { await onAction("add_communication", { companyId: company.id, text: text.trim(), occurredAt: submittedOccurredAt ? new Date(submittedOccurredAt).toISOString() : "", dataClass }); setText(""); setOccurredAt(""); } catch { /* Keep unsaved text for retry. */ }
  };
  const evidence = company.evidence || [];
  const communications = company.communications || [];
  const firstSource = evidence.find(item => item.type === "webpage" && item.status !== "inferred") || evidence.find(item => item.status !== "inferred");
  const sourceUrl = (id?: string) => evidence.find(item => item.id === id)?.url;
  const websiteFacts = company.websiteFacts || [];
  const history = events.filter(event => event.companyId === company.id).slice(-8).reverse();
  const visibleError = error || (company.researchError ? `最近一次网站研究未完成：${company.researchError}` : "");
  const researchLabel = { complete: "已完成研究", evidence_only: "已取原文 · 分析待运行", failed: "研究未完成", not_started: "尚未研究" }[company.researchStatus || "not_started"];
  return <><div className="ts-drawer-layer" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="ts-drawer ts-customer-detail" ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="ts-drawer-title">
      <header className="ts-drawer-header"><span><ShieldCheck size={16} />客户工作簿</span><div className="ts-detail-header-right"><small>原文 · 判断 · 行动</small><button className="ts-icon-button" aria-label="关闭客户详情" onClick={onClose}><X size={21} /></button></div></header>
      <div className="ts-drawer-identity"><CompanyAvatar company={company} /><div><div className="ts-inline-row"><h2 id="ts-drawer-title">{company.name}</h2>{isDemoCompany(company) && <span className="ts-demo-tag">案例</span>}</div><ExternalLink url={company.website}>{hostname(company.website)}</ExternalLink></div></div>
      <div className="ts-drawer-labels"><GradeBadge grade={company.grade} /><span className="ts-stage">{company.stage || "待研究"}</span><span className="ts-muted">{company.market || "市场待核验"}</span><span className={`ts-detail-research-status ${company.researchStatus === "failed" ? "has-error" : ""}`}>{researchLabel}</span></div>
      <div className="ts-drawer-tools">{!company.website?.trim() && onUpdated ? <Button variant="primary" onClick={() => setWebsiteResolverOpen(true)} disabled={!!busy}><Globe2 size={16} />查找官网</Button> : <Button variant="primary" onClick={() => onResearch(company)} busy={busy === `research:${company.id}`} disabled={!!busy}><Search size={16} />{modelConfigured ? "研究客户网站" : "获取网站原文"}</Button>}<Button onClick={onEdit} disabled={!!busy}><Pencil size={15} />编辑客户</Button>{onFinancialReview && <Button onClick={onFinancialReview} disabled={!!busy}><FileText size={15} />财报核验</Button>}</div>
      <div className="ts-drawer-tabs" role="tablist" aria-label="客户详情">{([['overview', '概况与跟进'], ['evidence', `来源依据 ${evidence.length}`], ['communication', `沟通与记忆 ${communications.length}`]] as const).map(([value, label]) => <button key={value} id={`ts-detail-tab-${value}`} role="tab" aria-controls="ts-detail-panel" aria-selected={tab === value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}</button>)}</div>
      <div className="ts-drawer-body" id="ts-detail-panel" role="tabpanel" aria-labelledby={`ts-detail-tab-${tab}`}>
        {websiteNotice && <div className="ts-saved-notice" role="status"><CheckCircle2 size={16} />{websiteNotice}</div>}
        {visibleError && <div className="ts-inline-error" role="alert">{visibleError}</div>}
        {tab === "overview" && <>
          <NextActionCard company={company} onEdit={onEdit} disabled={!!busy} />
          {firstSource && <section className="ts-source-snapshot ts-detail-source"><div className="ts-section-heading"><h3><FileText size={16} />来源原文</h3><button className="ts-text-button" onClick={() => setTab("evidence")}>查看全部 {evidence.length} 条 <ArrowUpRight size={14} /></button></div>
            <span className="ts-detail-source-label">{firstSource.status === "reported" ? "来源自述" : "原文可见"} · {firstSource.title || "已保存的来源片段"}</span><blockquote>{firstSource.snippet || "该来源尚无可显示的原文片段。"}</blockquote><div className="ts-detail-source-footer">{firstSource.url && <ExternalLink url={firstSource.url}>打开原始来源</ExternalLink>}<span>{firstSource.capturedAt ? `留存于 ${formatDate(firstSource.capturedAt, true)}` : "留存时间未记录"}</span></div>
            <small>保留网页与材料原话；来源自述不等于当前采购意向或支付能力。</small>
          </section>}
          {(websiteFacts.length > 0 || company.suggestedNextAction) && <section className="ts-detail-judgment"><div className="ts-section-heading"><h3>研究整理</h3><span>系统建议 · 待人工核对</span></div>{websiteFacts.slice(0, 2).map((fact, index) => <div className="ts-detail-finding" key={index}><p>{fact.value}</p><details><summary>核对这条整理的依据</summary><blockquote>{fact.quote}</blockquote><ExternalLink url={sourceUrl(fact.sourceId)}>对应来源</ExternalLink></details></div>)}{company.suggestedNextAction && <div className="ts-detail-suggestion"><small>建议下一步 · 不会自动写入跟进安排</small><p>{company.suggestedNextAction}</p></div>}</section>}
          <PreContactCheck key={company.id} company={company} onEvidence={() => setTab("evidence")} />
          {onFindBuyers && <section className="ts-detail-discovery"><div><span className="ts-detail-kicker">把这次了解，用到下一次找客</span><h3>从这家企业继续找客</h3><p>参考已有资料，自选产品、目标市场和买家角色，预览查询后搜索新的待核验企业。</p></div><Button onClick={onFindBuyers} disabled={!!busy}><Search size={16} />按这个客户找更多买家</Button></section>}
          <section className="ts-detail-section"><div className="ts-section-heading"><h3>已记录产品与联系进展</h3></div>
            <dl className="ts-detail-list"><div><dt>产品关联</dt><dd className="ts-code-list">{company.productRefs?.length ? company.productRefs.map(value => <code key={value}>{value}</code>) : <span className="ts-muted">尚未确认对应型号</span>}</dd></div><div><dt>负责人</dt><dd>{company.owner || "未分配"}</dd></div><div><dt>最近沟通</dt><dd>{company.lastContactAt ? formatDate(company.lastContactAt, true) : "暂无沟通记录"}</dd></div></dl>
          </section>
          <section className="ts-detail-section"><h3>待补证事项</h3>{company.missingEvidence?.length ? <ul className="ts-evidence-gaps">{company.missingEvidence.map((value, index) => <li key={index}><span />{value}</li>)}</ul> : <p className="ts-muted">暂无已登记的缺失项；仍请核对产品、角色与当前采购需求。</p>}</section>
          <section className="ts-detail-section"><div className="ts-section-heading"><h3>公开联系入口</h3><span className="ts-detail-mini-note">岗位与可联系性待核验</span></div>{company.contacts?.length ? <div className="ts-contact-list">{company.contacts.map((contact, index) => <div key={`${contact.value}-${index}`}><div><span className="ts-contact-type">{contact.type === "email" ? <Mail size={16} /> : <Globe2 size={16} />}{contact.role || "通用入口 · 岗位待核验"}</span><strong>{contact.value}</strong></div>{contact.sourceUrl && <ExternalLink url={contact.sourceUrl}>来源</ExternalLink>}</div>)}</div> : <p className="ts-muted">尚无已保存的联系入口。研究官网 Contact / About 页后核验部门。</p>}</section>

          {company.notes && <section className="ts-detail-section"><h3>业务备注 / 导入原文</h3><p className="ts-preserve-text">{company.notes}</p></section>}
          <section className="ts-detail-section"><div className="ts-section-heading"><h3>资料来源</h3><button className="ts-text-button" onClick={() => setTab("evidence")}>查看全部 <ArrowUpRight size={14} /></button></div><p className="ts-muted">{evidence.length ? `已保存 ${evidence.length} 条可回看的原文依据。` : "当前无网页原文，先保存来源再判断。"}</p></section>
        </>}
        {tab === "evidence" && <>
          <div className="ts-info-box"><ShieldCheck size={18} /><p>先看对方说了什么，再判断是否值得联系。“原文可见”“来源自述”和“推断”分别保留。</p></div>
          {evidence.length ? evidence.map(item => <article className="ts-evidence-card" key={item.id}><div className="ts-evidence-card-head"><span className="ts-source-type">{item.type === "webpage" ? <Globe2 size={15} /> : <FileText size={15} />}{item.type === "webpage" ? "公开网页" : item.type === "document" ? "企业材料" : "人工记录"}</span><span className="ts-observation">{{ observed: "原文可见", reported: "来源自述", inferred: "推断待确认" }[item.status] || "待核验"}</span></div><h3>{item.title || "来源记录"}</h3><blockquote>{item.snippet || "该来源尚无可显示的原文片段。"}</blockquote><footer>{item.url ? <ExternalLink url={item.url}>查看原网页</ExternalLink> : <span className="ts-muted">无公开链接</span>}<time>{item.capturedAt ? formatDate(item.capturedAt, true) : "时间未记录"}</time></footer></article>) : <EmptyState compact icon={<FileText size={26} />} title="还没有保存原文" description="添加企业官网后获取网页原文，或在备注中保存已核验的资料。"><Button onClick={() => onResearch(company)} disabled={!!busy || !safeUrl(company.website)}><Search size={16} />获取网站原文</Button></EmptyState>}
        </>}
        {tab === "communication" && <>
          <form className="ts-message-form" onSubmit={saveMessage}><span className="ts-detail-kicker">先留原话，再确认变化</span><h3>记录一段新沟通</h3><p>粘贴已授权的聊天文字。这里只留存原话；问交期不会自动变成订单，数量也不会自动写入询价。</p><label className="ts-field">沟通原文<textarea required rows={5} value={text} onChange={event => setText(event.target.value)} placeholder="粘贴 WhatsApp、Facebook、邮件或其他已授权的沟通文字…" /></label><label className="ts-field">记录性质<select value={dataClass} onChange={event => setDataClass(event.target.value as "real" | "synthetic")} disabled={!!busy}><option value="real">真实业务记录</option><option value="synthetic">演示样例</option></select><small>演示样例会明确标记，不代表真实客户往来。</small></label><label className="ts-field">沟通发生时间（未知可留空）<input type="datetime-local" name="occurredAt" value={occurredAt} onChange={event => setOccurredAt(event.target.value)} /></label>{messageError && <p className="ts-inline-error" role="alert">{messageError}</p>}<div className="ts-message-actions"><small>按本机时区填写；留空保留未知。记录展示采用北京时间。</small><Button type="submit" variant="primary" busy={busy === "add_communication"} disabled={!!busy || !text.trim()}><CheckCircle2 size={16} />保存沟通记录</Button></div></form>
          <CommunicationChanges key={company.id} company={company} busy={busy} onAction={onAction} />
          <h3 className="ts-history-heading">沟通历史 <span>{communications.length}</span></h3>
          {communications.length ? [...communications].reverse().map(item => <article className="ts-message-card" key={item.id}><div><MessageSquare size={15} /><time>{item.occurredAt ? `发生于 ${formatDate(item.occurredAt, true)}` : "发生时间未知"}</time>{item.dataClass === "synthetic" && <span className="ts-demo-tag">演示样例</span>}</div><p>{item.text}</p><small>{item.recordedAt ? `保存于 ${formatDate(item.recordedAt, true)}` : "保存时间未记录"}</small></article>) : <p className="ts-muted ts-no-history">暂无历史沟通。保存后刷新页面仍可查看。</p>}
          {history.length > 0 && <section className="ts-detail-section"><h3>更新轨迹</h3><ol className="ts-timeline">{history.map(item => <li key={item.id}><span /><div><strong>{item.summary || item.title || ({ company_created: "建立客户记录", company_updated: "更新客户资料", communication_added: "保存沟通记录", research_completed: "保存网站研究结果", seed: "载入来源案例", create_company: "建立客户记录", update_company: "更新客户资料", add_communication: "保存沟通记录" }[item.type || ""] || "客户记录已更新")}</strong><time>{formatDate(item.createdAt || item.occurredAt, true)}</time></div></li>)}</ol></section>}
        </>}
      </div>
      <footer className="ts-drawer-footer"><ShieldCheck size={14} /><span>保存成功后同步到工作区 · 修改留痕 · 展示时间为北京时间</span></footer>
    </aside>
  </div>{websiteResolverOpen && onUpdated && <CompanyWebsiteResolver key={company.id} company={company} onUpdated={onUpdated} onClose={() => setWebsiteResolverOpen(false)} onComplete={() => { setWebsiteResolverOpen(false); setWebsiteNotice("官网与来源已补入当前客户，可继续研究网站。公开联系方式的岗位仍需核实。"); }} />}</>;
}

function NextActionCard({ company, onEdit, disabled }: { company: Company; onEdit: () => void; disabled: boolean }) {
  const overdue = isOverdue(company.nextFollowUpAt);
  return <section className={`ts-detail-next-action ${overdue ? "is-overdue" : ""}`} aria-label="已登记的下一步跟进">
    <div className="ts-detail-next-heading"><span><CalendarDays size={16} />下一步跟进</span><button className="ts-text-button" onClick={onEdit} disabled={disabled}><Pencil size={13} />{company.nextAction ? "调整安排" : "安排跟进"}</button></div>
    <h3>{company.nextAction || "还没有安排下一步"}</h3>
    {!company.nextAction && <p>把需要补问的问题，交给具体的人和时间。</p>}
    <div className="ts-detail-next-meta"><div><UserRound size={16} /><span><small>负责人</small><strong>{company.owner || "待分配"}</strong></span></div><div><Clock3 size={16} /><span><small>跟进时间 · 北京时间</small><strong>{company.nextFollowUpAt ? formatDate(company.nextFollowUpAt, true) : "尚未安排"}{overdue && <em>已逾期</em>}</strong></span></div></div>
  </section>;
}

function PreContactCheck({ company, onEvidence }: { company: Company; onEvidence: () => void }) {
  const [copyStatus, setCopyStatus] = useState("");
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const questionDetails = useRef<HTMLDetailsElement>(null);
  const evidence = company.evidence || [];
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const matches = (company.researchProductMatches || []).filter(match => {
    const source = evidence.find(item => item.id === match.sourceId);
    return ["same_code", "related_category"].includes(match.relationship) && !!match.quote?.trim() && !!source && normalize(source.snippet).includes(normalize(match.quote));
  });
  const references = (company.productRefs || []).map(value => value.trim()).filter(value => value && !/^(未知|待核验|未确认|待补充)$/.test(value));
  const productText = references.slice(0, 3).join(", ") + (references.length > 3 ? " and the other listed items" : "");
  const researchQuestion = company.lastQuestion?.trim() || "";
  const manualQuestion = productText ? `Does your team directly source ${productText} for commercial vehicles, and could you confirm the application, original size or variant, applicable standard or model year, and required quantity and unit?` : "";
  const question = researchQuestion || manualQuestion;
  const copyQuestion = async () => {
    if (!question) return;
    try { await navigator.clipboard.writeText(question); setCopyStatus("补问已复制。平台未发送消息。"); }
    catch {
      if (questionDetails.current) questionDetails.current.open = true;
      questionRef.current?.focus(); questionRef.current?.select();
      setCopyStatus("浏览器未允许自动复制，已选中文本，请手动复制。");
    }
  };
  return <section className="ts-contact-check" aria-label="联系前核验">
    <div className="ts-section-heading"><h3><ShieldCheck size={17} />联系前核验</h3><button className="ts-text-button" onClick={onEvidence}>核对来源</button></div>
    <dl className="ts-contact-check-list">
      <div><dt>买家角色</dt><dd><strong>{company.buyerRole || "待确认"}</strong><small>已录入 / 来源自述；直接采购职责与采购能力仍需确认。</small></dd></div>
      <div><dt>产品关联</dt><dd>{matches.length ? <>{matches.slice(0, 2).map((match, index) => <div className="ts-contact-match" key={`${match.sourceId}-${index}`}><div><strong>{match.relationship === "same_code" ? "同编号引用" : "相关品类引用"}</strong><ExternalLink url={evidence.find(item => item.id === match.sourceId)?.url}>原文</ExternalLink></div><q>{match.quote}</q></div>)}<small>引用关联保留为候选，尚未确认具体适配。{matches.length > 2 && <button className="ts-text-button" onClick={onEvidence}>查看其余来源</button>}</small></> : <><strong>尚无可回看的产品关联引用</strong><small>{references.length ? "已录入的产品编号仍需与来源、编号体系逐项核对。" : "先补录明确产品编号，再核验同编号或相关品类来源。"}</small></>}</dd></div>
      <div><dt>适配 / 报价条件</dt><dd><strong>待逐项确认</strong><small>编号体系、原始 SIZE（STD / 1+ / 2+）、市场与年份 / 标准版本、数量及单位。</small></dd></div>
    </dl>
    {question ? <div className="ts-contact-question"><div className="ts-contact-question-head"><span>{researchQuestion ? "已有研究问句 · 待人工审核" : "人工英文模板"}</span><Button onClick={copyQuestion}><Copy size={15} />复制补问</Button></div><details ref={questionDetails}><summary>查看并核对补问内容</summary><textarea ref={questionRef} readOnly rows={4} value={question} aria-label={researchQuestion ? "已有研究问句" : "人工英文模板"} />{researchQuestion && company.openingQuestionEvidence && <div className="ts-contact-question-source"><q>{company.openingQuestionEvidence.quote}</q><ExternalLink url={evidence.find(item => item.id === company.openingQuestionEvidence?.sourceId)?.url}>问句依据</ExternalLink></div>}</details>{copyStatus && <p role="status">{copyStatus}</p>}</div> : <p className="ts-contact-question-empty">补录产品编号后可准备针对性的人工英文模板。</p>}
  </section>;
}
