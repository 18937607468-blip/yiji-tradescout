"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpenCheck, CheckCircle2, Globe2, Loader2, Mail, Phone, RefreshCw, Search } from "lucide-react";
import { Button, ExternalLink, Modal } from "./PlatformUI";
import { Company, PlatformState, formatDate, isDemoCompany, safeUrl } from "./types";
import type { WebsiteResolutionAttachResult, WebsiteResolutionCandidate, WebsiteResolutionCriteria, WebsiteResolutionInspectResult, WebsiteResolutionPlan, WebsiteResolutionRun, WebsiteResolutionSearchResult } from "./company-website-types";
import "./CompanyWebsiteResolver.css";
import SearchQueryDiagnostics from "./SearchQueryDiagnostics";

type Props = { company: Company; onUpdated: (state: Partial<PlatformState>) => void; onClose: () => void; onComplete: () => void };
type ResponseBody = { ok?: boolean; result?: WebsiteResolutionPlan | WebsiteResolutionSearchResult | WebsiteResolutionInspectResult | WebsiteResolutionAttachResult; data?: Partial<PlatformState>; error?: { message?: string } };
const fingerprint = (criteria: WebsiteResolutionCriteria) => JSON.stringify({ name: criteria.name.trim(), country: criteria.country.trim() });
const normalizeManualUrl = (value: string) => {
  if (!value.trim()) return "";
  try {
    const url = new URL(value.trim().includes("://") ? value.trim() : `https://${value.trim()}`);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
    url.hash = ""; return url.href;
  } catch { return ""; }
};
const statusLabel = (candidate: WebsiteResolutionCandidate) => ({ unverified: "仅搜索摘要", inspecting: "正在读取官网", needs_review: "有名称线索 · 待人工核对", needs_evidence: "身份依据不足", blocked: "读取未完成" }[candidate.status]);

export default function CompanyWebsiteResolver({ company, onUpdated, onClose, onComplete }: Props) {
  const [criteria, setCriteria] = useState<WebsiteResolutionCriteria>({ name: company.name, country: "" });
  const [plan, setPlan] = useState<WebsiteResolutionPlan | null>(null);
  const [run, setRun] = useState<WebsiteResolutionRun | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [manualConfirmed, setManualConfirmed] = useState(false);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [expandedId, setExpandedId] = useState("");
  const [busy, setBusy] = useState("initial");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cached, setCached] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const requestId = useRef({ signature: "", id: "" });
  const lock = useRef(false);
  const resultsRef = useRef<HTMLElement>(null);
  const planStale = !!plan && fingerprint(plan.criteria) !== fingerprint(criteria);
  const manualUrlHref = normalizeManualUrl(manualUrl);
  const manualRun = run?.sourceKind === "manual_url";
  const runStale = !!run && (fingerprint(run.criteria) !== fingerprint(criteria) || (manualRun && normalizeManualUrl(run.candidates[0]?.url || "") !== manualUrlHref));
  const expectedRevision = run?.companyRevision ?? plan?.expectedRevision;
  const revisionStale = expectedRevision !== undefined && expectedRevision !== (company.revision ?? 1);
  const hasWebsite = !!company.website?.trim();
  const manualQuery = [criteria.name.trim(), criteria.country.trim()].filter(Boolean).join(" ");
  const inspectLimit = plan?.limits.inspectPerRun || 3;
  const pageLimit = plan?.limits.pagesPerCandidate || 2;
  const selected = run?.candidates.find(item => item.id === expandedId);
  const stage = busy === "inspect_url" ? 3 : busy === "search" ? 2 : selected?.evidence.length ? 4 : run ? 3 : 1;

  const request = async (payload: Record<string, unknown>, timeoutMs = 65000) => {
    const controller = new AbortController(); abortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch("/api/platform/company-website", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
      let body: ResponseBody;
      try { body = await response.json(); } catch { throw new Error(`服务响应无法读取（${response.status}），没有生成替代结果。`); }
      if (body.data?.companies) onUpdated(body.data);
      if (!response.ok || !body.ok) throw new Error(body.error?.message || `操作未完成（${response.status}），已有输入和来源仍保留。`);
      return body;
    } catch (cause) {
      throw new Error(cause instanceof Error && cause.name === "AbortError" ? "请求超时，最终状态暂不确定。请先关闭窗口并刷新客户记录，核对是否已补入，再决定是否重试。" : cause instanceof Error ? cause.message : "请求未完成，请稍后重试。");
    } finally { clearTimeout(timer); }
  };

  useEffect(() => {
    let active = true;
    lock.current = true;
    void request({ mode: "plan", companyId: company.id }, 15000).then(body => {
      if (!active) return;
      const next = body.result as WebsiteResolutionPlan;
      if (!next?.planHash || next.companyId !== company.id || !Array.isArray(next.queries)) throw new Error("公开搜索条件未准备好，请重新读取。");
      setCriteria(next.criteria); setPlan(next);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "读取条件失败。"); }).finally(() => { if (active) { setBusy(""); lock.current = false; } });
    return () => { active = false; abortRef.current?.abort(); };
    // A company owns this session; background state refresh must not erase input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id]);

  const close = () => { if (busy) { setNotice("当前操作进行中，完成后可关闭；请保留窗口查看真实回执。"); return; } onClose(); };
  const update = (key: keyof WebsiteResolutionCriteria, value: string) => {
    setCriteria(current => ({ ...current, [key]: value })); setConfirmed(false); setManualConfirmed(false); setIdentityConfirmed(false); setError(""); setNotice("");
  };
  const prepare = async () => {
    if (lock.current || criteria.name.trim().length < 2 || hasWebsite) return;
    lock.current = true; setBusy("plan"); setError(""); setNotice(""); setConfirmed(false); setManualConfirmed(false); setIdentityConfirmed(false);
    try {
      const body = await request({ mode: "plan", companyId: company.id, criteria }, 15000);
      const next = body.result as WebsiteResolutionPlan;
      if (!next?.planHash || next.companyId !== company.id || !Array.isArray(next.queries)) throw new Error("搜索条件响应不完整，没有发起外部搜索。");
      setCriteria(next.criteria); setPlan(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "条件未更新。"); }
    finally { lock.current = false; setBusy(""); }
  };
  const search = async () => {
    if (lock.current || !plan || planStale || !confirmed || revisionStale || hasWebsite) return;
    lock.current = true; setBusy("search"); setError(""); setNotice(""); setIdentityConfirmed(false);
    try {
      const body = await request({ mode: "search", companyId: company.id, criteria, planHash: plan.planHash, confirmed: true });
      const result = body.result as WebsiteResolutionSearchResult;
      if (!result?.run?.id || result.run.companyId !== company.id || !Array.isArray(result.run.candidates)) throw new Error("搜索回执不完整，请重新打开核对，没有使用预设网站。");
      setRun(result.run); setCached(result.cached); setExpandedId("");
      setNotice(result.cached ? "已读取同条件的保存记录，没有重复发起搜索。请留意下方来源时间。" : result.run.status === "failed" ? "本次真实搜索未完成，失败原因见查询记录。" : result.run.status === "partial" ? "部分查询成功。已保留实际取得的候选，失败原因见查询记录。" : `取得 ${result.run.candidates.length} 个候选网站，尚未确认与当前客户是同一家公司。`);
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "搜索未完成。"); if (run) setNotice("下方仍是此前的搜索记录，本次请求尚未取得新结果。"); }
    finally { lock.current = false; setBusy(""); }
  };
  const inspect = async (candidate: WebsiteResolutionCandidate) => {
    if (lock.current || !run || runStale || revisionStale || hasWebsite) return;
    lock.current = true; setBusy(`inspect:${candidate.id}`); setExpandedId(candidate.id); setIdentityConfirmed(false); setError(""); setNotice("");
    try {
      const body = await request({ mode: "inspect", runId: run.id, candidateId: candidate.id }, 45000);
      const result = body.result as WebsiteResolutionInspectResult;
      if (!result?.candidate || result.run?.companyId !== company.id || result.run.id !== run.id) throw new Error("官网取证回执不完整，请先核对已保存记录。");
      setRun(result.run);
      setNotice(result.cached ? "已打开保存的官网原文，没有重复读取网站。" : result.candidate.evidence.length ? "已保存实际官网原文。名称出现只是线索，请人工核对企业身份。" : "未取得可用官网原文，原因已记录；不能据此补入官网。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "官网读取未完成。"); }
    finally { lock.current = false; setBusy(""); }
  };
  const inspectUrl = async () => {
    if (lock.current || !manualConfirmed || !manualUrlHref || criteria.name.trim().length < 2 || revisionStale || hasWebsite) return;
    lock.current = true; setBusy("inspect_url"); setError(""); setNotice(""); setIdentityConfirmed(false);
    try {
      const body = await request({ mode: "inspect_url", companyId: company.id, criteria, url: manualUrlHref, expectedRevision: company.revision ?? 1, confirmed: true }, 45000);
      const result = body.result as WebsiteResolutionInspectResult;
      if (!result?.candidate || result.run?.companyId !== company.id || result.run.sourceKind !== "manual_url" || !result.run.candidates.some(item => item.id === result.candidate.id)) throw new Error("网址取证回执不完整，尚不能认定核验成功。");
      setRun(result.run); setCriteria(result.run.criteria); setManualUrl(result.candidate.url); setCached(result.cached); setExpandedId(result.candidate.id);
      setNotice(result.cached ? "已打开这个网址保存的原文，没有再次读取网站，也没有调用搜索服务。" : result.candidate.evidence.length ? "已读取用户提供的网址，没有调用搜索服务。请核对下方名称原文与官网归属。" : "这个网址未取得可用原文，真实失败原因见下方；没有调用搜索，也未补入官网。");
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "网址取证未完成。"); if (run) setNotice("下方仍是此前的记录，本次提供的网址尚未完成取证。"); }
    finally { lock.current = false; setBusy(""); }
  };
  const attach = async (candidate: WebsiteResolutionCandidate) => {
    if (lock.current || !run || runStale || revisionStale || hasWebsite || !identityConfirmed || !candidate.candidateHash || candidate.status !== "needs_review" || !candidate.identityEvidence.length || (candidate.existingCompanyId && candidate.existingCompanyId !== company.id)) return;
    lock.current = true; setBusy(`attach:${candidate.id}`); setError(""); setNotice("");
    const signature = `${run.id}:${candidate.id}:${candidate.candidateHash}:${run.companyRevision}`;
    if (requestId.current.signature !== signature) requestId.current = { signature, id: crypto.randomUUID() };
    try {
      const body = await request({ mode: "attach", runId: run.id, candidateId: candidate.id, expectedCandidateHash: candidate.candidateHash, expectedRevision: run.companyRevision, confirmIdentity: true, clientRequestId: requestId.current.id }, 25000);
      const result = body.result as WebsiteResolutionAttachResult;
      if (result?.companyId !== company.id || !body.data?.companies?.find(item => item.id === company.id)?.website) throw new Error("保存回执不完整，请刷新客户核对，暂不认定补入成功。");
      onComplete();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "补入官网未完成。"); }
    finally { lock.current = false; setBusy(""); }
  };

  return <Modal title="为这家客户查找官网" description="公开搜索或提供网址 → 读取原文 → 核对身份 → 补入当前客户" onClose={close} wide>
    <div className="cw-resolver">
      <div className="cw-steps" aria-label="官网查找流程">{["核对条件", "取得网址", "读取原文", "确认补入"].map((label, index) => <span key={label} className={index < stage ? "active" : ""}><i>{index + 1}</i>{label}</span>)}</div>
      <div className="cw-company"><strong>{company.name}{isDemoCompany(company) && <span className="ts-demo-tag">来源案例</span>}</strong><p>当前客户 · {company.market || "国家 / 市场待核验"} · {hasWebsite ? "已有官网" : "官网待补充"}</p></div>
      {hasWebsite ? <div className="cw-status" role="status">当前客户已有官网。请关闭窗口，在客户详情继续研究或编辑；此入口不会覆盖已有官网。</div> : <>
        <div className="ts-form-grid"><label className="ts-field">公开公司名称<input value={criteria.name} minLength={2} maxLength={160} disabled={!!busy} onChange={event => update("name", event.target.value)} /></label><label className="ts-field">检索国家（可留空）<input value={criteria.country} maxLength={100} disabled={!!busy} placeholder="只用公开或已授权的国家信息" onChange={event => update("country", event.target.value)} /></label></div>
        {plan?.marketHint && <p className="cw-note">已记录的国家 / 市场：{plan.marketHint}。仅作检索参考，请核对后填写。</p>}
        {(!plan || planStale) && <Button onClick={prepare} disabled={!!busy || criteria.name.trim().length < 2} busy={busy === "plan"}><RefreshCw size={15} />{plan ? "更新搜索词预览" : "准备搜索条件"}</Button>}
        {plan && <section className="cw-preview"><h3><Search size={17} />将使用这些公开搜索词</h3>{plan.queries.map((query, index) => <code className="cw-query" key={`${index}:${query}`}>{query}</code>)}<p className="cw-note">{plan.provider} · 最多 {plan.limits.queries} 条查询；每轮核验 {inspectLimit} 家，每家最多 {pageLimit} 页。此流程不调用 B1X。</p>{plan.warnings.length > 0 && <ul className="cw-warnings">{plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}<label className="cw-confirm"><input type="checkbox" checked={confirmed} disabled={!!busy || planStale || revisionStale} onChange={event => setConfirmed(event.target.checked)} /><span>已核对公司名与国家，确认发起公开网页搜索</span></label><Button variant="primary" onClick={search} busy={busy === "search"} disabled={!!busy || planStale || revisionStale || !confirmed}><Search size={16} />开始真实搜索</Button></section>}
      </>}
      {busy === "initial" && <div className="cw-loading" role="status"><Loader2 className="ts-spin" size={18} />正在准备搜索条件，没有查询外部网站…</div>}
      {(runStale || (planStale && !manualRun)) && <p className="cw-status">名称、国家或网址条件已修改。之前的候选暂不能补入；请重新搜索，或确认下方网址后再次读取原文。</p>}
      {revisionStale && !hasWebsite && <p className="ts-inline-error" role="alert">客户资料版本已变化。请关闭后重新打开，核对最新资料再查找，避免补入错误版本。</p>}
      {error && <p className="ts-inline-error" role="alert">{error}</p>}
      {notice && <p className="cw-status" role="status">{notice}</p>}
      {!hasWebsite && <section className="cw-url-fallback"><h3><Globe2 size={17} />已有官网？粘贴后继续核验</h3><p className="cw-note">直接读取您提供的公开网址，最多 {pageLimit} 页，不调用搜索服务或 B1X。</p><label className="ts-field">待核验官网网址<input type="url" inputMode="url" autoComplete="url" maxLength={2048} value={manualUrl} disabled={!!busy} placeholder="https://company.com" onChange={event => { setManualUrl(event.target.value); setManualConfirmed(false); setIdentityConfirmed(false); }} /></label>{manualUrl.trim() && !manualUrlHref && <p className="ts-inline-error">请填写有效的 http / https 网址，网址中不要携带账号或密码。</p>}{manualUrlHref && <div className="cw-url-preview"><strong>本次核对对象</strong><span>{criteria.name.trim() || "请先填写公开公司名"}{criteria.country.trim() ? ` · ${criteria.country.trim()}` : ""}</span><ExternalLink url={manualUrlHref}>{manualUrlHref}</ExternalLink></div>}<label className="cw-confirm"><input type="checkbox" checked={manualConfirmed} disabled={!!busy || !manualUrlHref || criteria.name.trim().length < 2 || revisionStale} onChange={event => setManualConfirmed(event.target.checked)} /><span>已核对公司名和网址，确认读取此公开网站；官网归属将在读到原文后再次确认</span></label><Button onClick={inspectUrl} variant="primary" busy={busy === "inspect_url"} disabled={!!busy || !manualConfirmed || !manualUrlHref || criteria.name.trim().length < 2 || revisionStale}><BookOpenCheck size={16} />读取这个网址的原文</Button></section>}
      {run && <section className="cw-results" ref={resultsRef}><div className="cw-results-header"><div><h3><Globe2 size={17} />{manualRun ? "手工提供网址的核验记录" : `候选网站 · ${run.candidates.length}`}</h3><p>{formatDate(run.startedAt, true)} · {manualRun ? `${cached ? "已保存的取证记录" : "用户提供官网"} · 未调用搜索服务` : `${cached ? "已保存的搜索记录" : "真实搜索记录"} · 已核验 ${run.inspectionCount}/${inspectLimit}`}</p></div></div>
        <p className="cw-identity-note">网页标题和同名不等于同一家企业；公开联系方式也不等于采购负责人。</p>
        {!run.candidates.length && <div className="cw-blank"><strong>{run.status === "failed" ? "本次搜索未完成" : "本轮没有可用候选网站"}</strong><p>检查公司全称和公开国家信息，或通过下方人工检索页交叉核对。</p></div>}
        {run.candidates.map(candidate => {
          const expanded = expandedId === candidate.id;
          const taken = !!candidate.existingCompanyId && candidate.existingCompanyId !== company.id;
          const canAttach = candidate.status === "needs_review" && candidate.identityEvidence.length > 0 && !!candidate.candidateHash && !taken && !candidate.attachedCompanyId;
          return <article className={`cw-candidate ${expanded ? "selected" : ""}`} key={candidate.id}><div className="cw-candidate-head"><div className="cw-candidate-main"><h4>{candidate.title || candidate.domain}</h4><ExternalLink url={candidate.url}>{candidate.domain}</ExternalLink><p>{manualRun ? "网址由用户提供；实际取得的原文与联系方式见下方。" : candidate.searchSnippet || "搜索提供方未返回摘要。"}</p><span className={`cw-badge ${candidate.evidence.length ? "read" : candidate.status === "blocked" ? "error" : ""}`}>{statusLabel(candidate)}</span></div><Button onClick={() => { if (candidate.evidence.length || candidate.status === "blocked") { setExpandedId(expanded ? "" : candidate.id); setIdentityConfirmed(false); } else void inspect(candidate); }} busy={busy === `inspect:${candidate.id}`} disabled={!!busy || runStale || revisionStale || hasWebsite || candidate.status === "inspecting" || (!candidate.evidence.length && candidate.status !== "blocked" && run.inspectionCount >= inspectLimit)}><BookOpenCheck size={15} />{candidate.evidence.length || candidate.status === "blocked" ? expanded ? "收起依据" : "查看已存依据" : "读取官网原文"}</Button></div>
            {expanded && <div className="cw-details">
              {candidate.warnings.length > 0 && <ul className="cw-warnings">{candidate.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
              <div><h3>企业名称线索</h3>{candidate.identityEvidence.length ? candidate.identityEvidence.map((identity, index) => { const source = candidate.evidence.find(item => item.id === identity.sourceId); return <div className="cw-source" key={`${identity.sourceId}:${index}`}><blockquote>{identity.quote}</blockquote><div className="cw-source-footer"><ExternalLink url={source?.url}>名称原文来源</ExternalLink><time>{source?.capturedAt ? formatDate(source.capturedAt, true) : "来源时间未返回"}</time></div></div>; }) : <p className="cw-note">已读资料中尚无足够的名称依据，不能补入官网。可人工核对其他候选。</p>}</div>
              {candidate.evidence.length > 0 && <details><summary>查看已读取原文（{candidate.evidence.length} 页）</summary>{candidate.evidence.map(source => <div className="cw-source" key={source.id}><strong>{source.title || "公开网页"}</strong><blockquote>{source.snippet}</blockquote><div className="cw-source-footer"><ExternalLink url={source.url}>打开原始网页</ExternalLink><time>{source.capturedAt ? formatDate(source.capturedAt, true) : "时间未返回"}</time></div></div>)}</details>}
              <div><h3>公开联系入口</h3>{candidate.contacts.length ? <div className="cw-contacts">{candidate.contacts.map((contact, index) => <WebsiteContact key={`${contact.type}:${contact.value}:${index}`} contact={contact} />)}</div> : <p className="cw-note">未从已读取页面取得联系入口；不表示这家企业没有联系方式。</p>}</div>
              {taken && <p className="cw-note">这个网站已关联到客户库中的另一家企业。请先核对两条企业记录，当前不能直接合并。</p>}
              {candidate.attachedCompanyId ? <p className="cw-status">此候选已补入客户记录，可关闭窗口继续研究。</p> : canAttach && <div className="cw-save"><strong>补入 {company.name} 的官网与来源</strong><p>{candidate.evidence[0]?.url || candidate.url}</p><label className="cw-confirm"><input type="checkbox" checked={identityConfirmed} disabled={!!busy || runStale || revisionStale || hasWebsite} onChange={event => setIdentityConfirmed(event.target.checked)} /><span>已核对企业名称与官网归属，确认这是同一家公司</span></label><Button variant="primary" onClick={() => attach(candidate)} busy={busy === `attach:${candidate.id}`} disabled={!!busy || !identityConfirmed || runStale || revisionStale || hasWebsite}><CheckCircle2 size={16} />确认补入当前客户</Button></div>}
            </div>}
          </article>;
        })}
        {run.status === "failed" && <p className="cw-status" role="status">{run.queries.find(query => query.status === "failed" && query.message)?.message || "搜索未完成，请核对本轮查询记录。"}</p>}
        {run.queries.length > 0 && <details className="cw-manual"><summary>查看本轮查询与真实状态</summary>{run.queries.map((query, index) => <div className="cw-source" key={index}><strong>{query.status === "complete" ? `完成 · ${query.resultCount} 条返回` : query.status === "failed" ? "查询失败" : "尚未完成"}</strong><code className="cw-query">{query.query}</code>{query.message && <p className="cw-note">{query.message}</p>}<SearchQueryDiagnostics query={query} />{query.requestId && <p className="cw-note">请求 ID：{query.requestId}</p>}</div>)}</details>}
      </section>}
      <details className="cw-manual"><summary>人工交叉核对（打开检索页）</summary><p className="cw-note">只携带上方公开公司名称和国家；不会自动采集社媒资料。</p><div><ExternalLink url={`https://www.google.com/search?q=${encodeURIComponent(manualQuery)}`}>Google 检索</ExternalLink><ExternalLink url={`https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(manualQuery)}`}>LinkedIn 企业检索</ExternalLink></div></details>
    </div>
  </Modal>;
}

function WebsiteContact({ contact }: { contact: WebsiteResolutionCandidate["contacts"][number] }) {
  const href = contact.type === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.value) ? `mailto:${encodeURIComponent(contact.value)}` : contact.type === "phone" && /^\+?[\d ().-]+$/.test(contact.value) ? `tel:${contact.value.replace(/[^\d+]/g, "")}` : contact.type === "url" ? safeUrl(contact.value) : undefined;
  const isWhatsApp = contact.type === "url" && /(^|\.)((wa\.me)|(whatsapp\.com))$/.test((() => { try { return new URL(href || "").hostname; } catch { return ""; } })());
  return <div className="cw-contact"><div>{contact.type === "email" ? <Mail size={15} /> : contact.type === "phone" ? <Phone size={15} /> : <Globe2 size={15} />}{href ? <a href={href} target={contact.type === "url" ? "_blank" : undefined} rel="noopener noreferrer">{isWhatsApp ? `WhatsApp · ${contact.value}` : contact.value}</a> : <span>{contact.value}</span>}</div><small><span>公开入口 · 岗位未确认</span><ExternalLink url={contact.sourceUrl}>来源</ExternalLink></small></div>;
}
