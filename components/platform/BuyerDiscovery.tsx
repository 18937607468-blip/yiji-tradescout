"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowUpRight, BookOpenCheck, Building2, CheckCircle2, ChevronDown, FileText, Globe2, History, Loader2, Mail, MessageCircle, Phone, Plus, RefreshCw, Save, Search, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Button, ExternalLink, Modal } from "./PlatformUI";
import { CompanyEditor } from "./CompanyForms";
import { Company, PlatformState, formatDate, safeUrl } from "./types";
import { assessCompanyHs, CUSTOMS_QA_SOURCE_URL } from "@/lib/platform/customs-catalog.mjs";
import type { DiscoveryCandidate, DiscoveryCategory, DiscoveryCriteria, DiscoveryInspectResult, DiscoveryPlan, DiscoveryRole, DiscoveryRun, DiscoverySaveResult, DiscoverySearchResult } from "./discovery-types";
import "./BuyerDiscovery.css";
import SearchQueryDiagnostics from "./SearchQueryDiagnostics";

type Props = { state: PlatformState; seedCompany: Company; initialRunId?: string; onClose: () => void; onUpdated: (state: Partial<PlatformState>) => void; onOpenCompany: (companyId: string) => void; onCreateCompany: (payload: Record<string, unknown>) => Promise<string | null> };
type ApiResponse = { ok?: boolean; result?: DiscoveryPlan | DiscoverySearchResult | DiscoveryInspectResult | DiscoverySaveResult; data?: Partial<PlatformState>; error?: { message?: string } };
const CATEGORIES: Array<{ value: DiscoveryCategory; label: string }> = [{ value: "brake_lining", label: "鼓式刹车片 · Brake linings" }, { value: "disc_brake_pad", label: "盘式刹车片 · Disc brake pads" }, { value: "brake_shoe", label: "制动蹄 · Brake shoes" }];
const ROLES: Array<{ value: DiscoveryRole; label: string }> = [{ value: "importer", label: "进口商" }, { value: "distributor", label: "分销商" }, { value: "wholesaler", label: "批发商" }];
const categoryName = (value: string) => CATEGORIES.find(item => item.value === value)?.label || value;
const runStatus = (value: string) => ({ searching: "搜索中", complete: "搜索完成", partial: "部分搜索成功", failed: "搜索未完成" }[value] || value);
const fingerprint = (criteria: DiscoveryCriteria | null) => JSON.stringify(criteria ? {
  productId: criteria.productId, category: criteria.category, targetMarket: criteria.targetMarket,
  buyerRoles: criteria.buyerRoles, extraTerms: criteria.extraTerms, excludedTerms: criteria.excludedTerms,
  hsCode: criteria.hsCode || "", hsCategoryConfirmed: !!criteria.hsCategoryConfirmed,
} : null);

export default function BuyerDiscovery({ state, seedCompany, initialRunId, onClose, onUpdated, onOpenCompany, onCreateCompany }: Props) {
  const [tab, setTab] = useState<"search" | "history">("search");
  const [criteria, setCriteria] = useState<DiscoveryCriteria | null>(null);
  const [plan, setPlan] = useState<DiscoveryPlan | null>(null);
  const [planFingerprint, setPlanFingerprint] = useState("");
  const [run, setRun] = useState<DiscoveryRun | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("initial");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cached, setCached] = useState(false);
  const [receipt, setReceipt] = useState<DiscoverySaveResult | null>(null);
  const [expandedId, setExpandedId] = useState("");
  const [manualCreateOpen, setManualCreateOpen] = useState(false);
  const [searchFailure, setSearchFailure] = useState<{ queries: string[]; criteriaFingerprint: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const records = (state.discoveryRuns || []) as unknown as DiscoveryRun[];
  const history = records.filter(item => item.seedCompanyId === seedCompany.id).slice().reverse();
  const currentFingerprint = fingerprint(criteria);
  const planStale = !!plan && planFingerprint !== currentFingerprint;
  const runStale = !!run && fingerprint(run.criteria) !== currentFingerprint;
  const emptyRun = run && run.status !== "searching" && (run.status === "failed" || run.candidates.length === 0) ? run : null;
  const manualBasis = searchFailure || (emptyRun ? { queries: emptyRun.queries.map(item => item.query), criteriaFingerprint: fingerprint(emptyRun.criteria) } : null);
  const manualQueries = [...new Set((plan && !planStale ? plan.queries : manualBasis?.queries || []).filter(query => query.trim()))].slice(0, 2);
  const manualLinksDisabled = !!busy || (plan ? planStale || !confirmed : manualBasis?.criteriaFingerprint !== currentFingerprint);
  const inspectLimit = plan?.limits.inspectPerRun || 3;
  const pageLimit = plan?.limits.pagesPerCandidate || 3;
  const hsAssessment = assessCompanyHs(criteria?.hsCode || "");
  const hsProblem = !hsAssessment.formatValid ? "请核对原码：支持 6、8 或 10 位数字，可保留点和空格；不会补零。"
    : hsAssessment.options.length && hsAssessment.options.every(item => !item.supported) ? "这份原码指向离合器面片，当前找客支持三类制动件，不能转成刹车片搜索。"
    : hsAssessment.options.length && !hsAssessment.options.some(item => item.category === criteria?.category) ? "当前品类与 HS 参考范围不一致，请从下方明确选择本轮品类。"
    : hsAssessment.ambiguous && !criteria?.hsCategoryConfirmed ? "这个 HS 范围包含多个品类，请点选本轮要找的品类。" : "";

  const request = async (payload: Record<string, unknown>, timeoutMs = 65000): Promise<ApiResponse> => {
    const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetch("/api/platform/buyer-discovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: abort.signal });
      let body: ApiResponse;
      try { body = await response.json(); } catch { throw new Error(`搜索服务返回了无法读取的响应（${response.status}）。已有记录仍保留。`); }
      if (body.data?.companies) onUpdated(body.data);
      if (!response.ok || !body.ok) throw new Error(body.error?.message || `操作未完成（${response.status}），没有使用示例结果。`);
      return body;
    } catch (cause) {
      throw new Error(cause instanceof Error && cause.name === "AbortError" ? "请求超时，最终状态暂不确定。请先到历史记录刷新查看，避免重复发起；当前输入仍保留。" : cause instanceof Error ? cause.message : "请求未完成，输入和已有结果仍保留。");
    } finally { clearTimeout(timeout); }
  };

  useEffect(() => {
    let active = true;
    const savedRun = initialRunId ? (state.discoveryRuns as unknown as DiscoveryRun[]).find(item => item.id === initialRunId && item.seedCompanyId === seedCompany.id) : undefined;
    if (savedRun) {
      setRun(savedRun); setCriteria(structuredClone(savedRun.criteria)); setCached(true); setBusy("");
      setNotice("已打开保存的搜索记录；没有重新查询。可继续查看或核验这次任务。");
      return () => { active = false; controller.current?.abort(); };
    }
    setBusy("initial"); setError("");
    void request({ mode: "plan", seedCompanyId: seedCompany.id }, 15000).then(body => {
      if (!active) return;
      const next = body.result as DiscoveryPlan;
      if (!next?.planHash || !next.criteria || !Array.isArray(next.queries)) throw new Error("搜索条件未准备好，请重新读取。");
      setCriteria(next.criteria); setPlan(next); setPlanFingerprint(fingerprint(next.criteria));
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "读取搜索条件失败。"); }).finally(() => { if (active) setBusy(""); });
    return () => { active = false; controller.current?.abort(); };
    // The seed identity owns this form. Parent state updates must not reset edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedCompany.id, initialRunId]);

  const close = () => { if (busy) { setNotice("当前操作进行中，结束后可关闭。搜索和核验记录会保留在历史中。"); return; } onClose(); };
  const update = <K extends keyof DiscoveryCriteria>(key: K, value: DiscoveryCriteria[K]) => {
    setCriteria(current => current ? { ...current, [key]: value,
      ...(key === "hsCode" ? { hsCategoryConfirmed: false } : {}),
      ...(key === "category" ? { hsCategoryConfirmed: true, ...(current.productId && state.products.find(item => item.id === current.productId)?.category !== value ? { productId: "" } : {}) } : {}),
    } : current);
    setConfirmed(false); setReceipt(null); setError(""); setNotice("");
  };
  const changeProduct = (productId: string) => {
    const selected = state.products.find(item => item.id === productId);
    setCriteria(current => current ? { ...current, productId, ...(selected && CATEGORIES.some(item => item.value === selected.category) ? { category: selected.category as DiscoveryCategory, hsCategoryConfirmed: true } : {}) } : current);
    setConfirmed(false); setReceipt(null); setError(""); setNotice("");
  };
  const adoptCategory = (category: string) => {
    if (CATEGORIES.some(item => item.value === category)) update("category", category as DiscoveryCategory);
  };
  const prepare = async () => {
    if (busy || hsProblem) return;
    setBusy("plan"); setError(""); setNotice(""); setConfirmed(false);
    try {
      const body = await request({ mode: "plan", seedCompanyId: seedCompany.id, ...(criteria ? { criteria } : {}) }, 15000);
      const next = body.result as DiscoveryPlan;
      if (!next?.planHash || !next.criteria || !Array.isArray(next.queries)) throw new Error("搜索条件响应不完整，没有发起外部搜索。");
      setCriteria(next.criteria); setPlan(next); setPlanFingerprint(fingerprint(next.criteria));
      setNotice("搜索条件已准备好。核对下方实际搜索词，再开始搜索。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "搜索条件未生成。"); }
    finally { setBusy(""); }
  };
  const search = async () => {
    if (busy || !criteria || !plan || planStale || !confirmed || hsProblem) return;
    setBusy("search"); setError(""); setNotice(""); setReceipt(null); setSearchFailure(null);
    try {
      const body = await request({ mode: "search", seedCompanyId: seedCompany.id, criteria, planHash: plan.planHash, confirmed: true });
      const result = body.result as DiscoverySearchResult;
      if (!result?.run?.id || !Array.isArray(result.run.candidates)) throw new Error("搜索结果不完整，没有创建替代候选。");
      setRun(result.run); setCached(!!result.cached); setExpandedId("");
      setNotice(result.cached ? "复用已保存的同条件搜索记录，未重复请求搜索服务。时间与原始查询可在下方查看。" : result.run.status === "partial" ? "部分查询成功。已保留取得的候选；失败查询与原因可在运行依据中查看。" : result.run.status === "failed" ? "本次搜索未完成，请查看真实失败原因；没有使用固定名单替代。" : `找到 ${result.run.candidates.length} 个新的候选网站。先选少量核验产品与买家角色。`);
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (cause) { setSearchFailure({ queries: [...plan.queries], criteriaFingerprint: fingerprint(criteria) }); setError(cause instanceof Error ? cause.message : "搜索未完成，已有结果仍保留。"); if (run) { setCached(true); setNotice("本次搜索未完成；下方仍是之前保存的搜索结果，不代表刚刚获取的新结果。可到历史记录刷新核对。"); } }
    finally { setBusy(""); }
  };
  const inspect = async (candidate: DiscoveryCandidate) => {
    if (busy || !run || runStale) return;
    setBusy(`inspect:${candidate.id}`); setError(""); setNotice(""); setExpandedId(candidate.id);
    try {
      const body = await request({ mode: "inspect", runId: run.id, candidateId: candidate.id }, 45000);
      const result = body.result as DiscoveryInspectResult;
      if (!result?.run?.id || !result.candidate) throw new Error("官网核验响应不完整，请在历史中刷新核对。");
      setRun(result.run);
      setNotice(result.candidate.status === "related_evidence" ? "已找到产品与买家角色的官网引用，仍需确认企业身份和当前采购需求。" : result.candidate.status === "blocked" ? "官网读取未完成，限制或错误已记录；未尝试绕过访问限制。" : "官网原文已保留；缺少的产品或买家角色依据已列出，不自动认定为合格买家。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "官网核验未完成。"); }
    finally { setBusy(""); }
  };
  const reassess = async (candidate: DiscoveryCandidate) => {
    if (busy || !run || runStale || !candidate.evidence.length || candidate.status === "inspecting") return;
    setBusy(`reassess:${candidate.id}`); setError(""); setNotice(""); setExpandedId(candidate.id);
    try {
      const body = await request({ mode: "reassess", runId: run.id, candidateId: candidate.id }, 15000);
      const result = body.result as DiscoveryInspectResult;
      if (!result?.run?.id || !result.candidate) throw new Error("重新核对的响应不完整，请刷新历史核对。");
      setRun(result.run);
      setNotice("已按当前规则重新核对保存的原文，没有再次访问网站，也没有占用新的官网核验名额。联系方式和缺口以保留的原始资料为准。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "重新核对未完成，已有原文仍保留。"); }
    finally { setBusy(""); }
  };
  const save = async (candidate: DiscoveryCandidate, companyName: string) => {
    if (busy || !run || runStale || !candidate.candidateHash) return;
    setBusy(`save:${candidate.id}`); setError(""); setNotice("");
    try {
      const body = await request({ mode: "save", runId: run.id, candidateId: candidate.id, companyName: companyName.trim(), confirmIdentity: true, expectedCandidateHash: candidate.candidateHash }, 30000);
      const result = body.result as DiscoverySaveResult;
      if (!result?.companyId) throw new Error("保存回执缺少客户编号，请先刷新核对，避免重复保存。");
      const updated = (body.data?.discoveryRuns || []) as unknown as DiscoveryRun[];
      setRun(updated.find(item => item.id === run.id) || { ...run, candidates: run.candidates.map(item => item.id === candidate.id ? { ...item, savedCompanyId: result.companyId } : item) });
      setReceipt(result);
      setNotice(result.duplicate ? "该网站已对应一个客户，未重复创建，也没有覆盖已有分级和跟进安排。" : "新企业已保存为待核验客户，官网依据同时保留。可以打开客户继续用赛事模型研究。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存未完成。"); }
    finally { setBusy(""); }
  };
  const refreshHistory = async () => {
    if (busy) return; setBusy("refresh"); setError("");
    const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch("/api/platform/state", { cache: "no-store", signal: abort.signal });
      const body = await response.json() as ApiResponse;
      if (!response.ok || !body.ok || !body.data) throw new Error(body.error?.message || "历史记录暂未读取成功。");
      onUpdated(body.data);
      const updated = (body.data.discoveryRuns || []) as unknown as DiscoveryRun[];
      if (run) setRun(updated.find(item => item.id === run.id) || run);
      setNotice("已重新读取服务端搜索与核验记录。");
    } catch(cause) { setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "刷新超时，当前记录仍保留。"); }
    finally { clearTimeout(timeout); setBusy(""); }
  };
  const restore = (item: DiscoveryRun) => {
    setRun(item); setCriteria(structuredClone(item.criteria)); setPlan(null); setPlanFingerprint(""); setConfirmed(false); setCached(true); setReceipt(null); setExpandedId(""); setSearchFailure(null); setError(""); setNotice("已打开保存的搜索记录；没有重新查询。可继续核验尚未读取的候选。"); setTab("search");
  };

  // Reuse the existing blank creation form; keep this component's search/history state on cancel.
  if (manualCreateOpen) return <CompanyEditor busy={!!busy} error={error} onClose={() => { if (!busy) { setManualCreateOpen(false); setError(""); } }} onSave={async (type, payload) => {
    if (type !== "create_company") throw new Error("这里仅能新建客户，不能修改参考客户。");
    if (busy) return;
    setBusy("manual-create"); setError("");
    try {
      const companyId = await onCreateCompany(payload);
      setManualCreateOpen(false);
      if (companyId) onOpenCompany(companyId); else onClose();
    } catch (cause) { const message = cause instanceof Error ? cause.message : "保存未完成，输入内容仍保留。"; setError(message); throw new Error(message); }
    finally { setBusy(""); }
  }} />;

  return <Modal title="按这个客户找更多买家" description="先用公开条件发现新企业，再用产品与采购角色的原文缩小范围。" onClose={close} wide><div className="buyer-discovery-body">
    <div className="bd-tabs" role="tablist" aria-label="找客任务"><button role="tab" aria-selected={tab === "search"} onClick={() => setTab("search")} disabled={!!busy}><Search size={17} />本轮找客</button><button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")} disabled={!!busy}><History size={17} />搜索历史 {history.length}</button></div>
    {error && <div className="bd-message is-error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}
    {notice && <div className="bd-message" role="status"><CheckCircle2 size={18} /><span>{notice}</span></div>}
    {tab === "search" && <>
      <div className="bd-seed"><Building2 size={22} /><div><strong>参考客户：{seedCompany.name}</strong><p>仅将下面确认的公开业务条件用于找客。客户聊天、财报和整份档案不会发送给搜索服务。</p><p>公开搜索与规则初筛不消耗 B1X；保存重点客户后，可用赛事模型继续研究。</p></div></div>
      {busy === "initial" ? <div className="bd-loading"><Loader2 size={25} className="ts-spin" /><strong>正在整理搜索条件</strong><p>读取当前客户与产品资料，尚未请求外部搜索。</p></div> : !criteria ? <div className="bd-empty"><AlertCircle size={25} /><strong>搜索条件还未准备好</strong><p>保留现有客户资料，重新读取条件后继续。</p><Button onClick={prepare} busy={busy === "plan"} disabled={!!busy}><RefreshCw size={16} />重新读取条件</Button></div> : <section className="bd-section">
        <div className="bd-heading"><div><h3>核对要找什么样的买家</h3><p>市场是搜索范围；实际所在地、采购意向与付款能力仍需单独核验。</p></div></div>
        <div className="bd-fields">
          <label className="bd-field"><span>参考产品</span><select value={criteria.productId} onChange={event => changeProduct(event.target.value)} disabled={!!busy}><option value="">按产品类别找客</option>{state.products.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>同编号只作为研究线索，不确认唯一性或适配。</small></label>
          <label className="bd-field"><span>制动件类别</span><select value={criteria.category} onChange={event => update("category", event.target.value as DiscoveryCategory)} disabled={!!busy}>{CATEGORIES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label className="bd-field"><span>目标国家 / 市场</span><input value={criteria.targetMarket} onChange={event => update("targetMarket", event.target.value)} disabled={!!busy} maxLength={100} placeholder="如 Finland；留空搜索全球" /><small>建议使用当地或英文名称；不把搜索范围写成公司所在地。</small></label>
          <label className="bd-field"><span>补充公开关键词</span><input value={criteria.extraTerms} onChange={event => update("extraTerms", event.target.value)} disabled={!!busy} maxLength={120} placeholder="如 truck aftermarket；不要填内部客户信息" /></label>
          <div className="bd-span-2 bd-hs-field">
            <label className="bd-field"><span>HS 海关编码 <em>可选</em></span><input value={criteria.hsCode || ""} onChange={event => update("hsCode", event.target.value)} disabled={!!busy} maxLength={40} inputMode="numeric" placeholder="如 681381；支持 6 / 8 / 10 位，留空不限制" /><small>用于补充公开网页搜索；不会直接查询海关平台。</small></label>
            {!!criteria.hsCode?.trim() && <div className="bd-hs-assessment">
              {hsAssessment.options.length > 0 && <><p>{hsAssessment.ambiguous ? "按企业原码清单，这个范围可能对应：" : "企业原码清单中的品类提示："}</p><div className="bd-hs-options">{hsAssessment.options.map(option => <Button key={option.category} disabled={!!busy || !option.supported} onClick={() => adoptCategory(option.category)} aria-pressed={criteria.category === option.category && !!criteria.hsCategoryConfirmed}>{criteria.category === option.category && criteria.hsCategoryConfirmed && <CheckCircle2 size={14} />}{option.supported ? `选择${option.label}` : `${option.label} · 暂不支持`}</Button>)}</div></>}
              {hsProblem && <p className="bd-hs-problem" role="status"><AlertCircle size={15} />{hsProblem}</p>}
              {hsAssessment.formatValid && !hsAssessment.options.length && <p>企业清单暂无对应品类，请结合产品资料手动核对。</p>}
              {hsAssessment.matchLevel === "hs6" && hsAssessment.normalizedCode.length > 6 && <p>完整码不在企业原码清单内；当前仅按前 6 位提示，完整含义仍待核对。</p>}
              <p className="bd-hs-footnote">未核对国家或年度税则；HS 不确认具体件号、适配或采购需求。<ExternalLink url={CUSTOMS_QA_SOURCE_URL}>企业原码来源</ExternalLink></p>
            </div>}
          </div>
          <fieldset className="bd-roles bd-span-2"><legend>优先查找的买家角色</legend><div className="bd-role-options">{ROLES.map(item => <label key={item.value}><input type="checkbox" checked={criteria.buyerRoles.includes(item.value)} disabled={!!busy} onChange={event => update("buyerRoles", event.target.checked ? [...criteria.buyerRoles, item.value] : criteria.buyerRoles.filter(value => value !== item.value))} />{item.label}</label>)}</div><p className="bd-role-note">进口与分销可能正是目标业务，不会因为“贸易公司”身份而一律排除。</p></fieldset>
          <label className="bd-field bd-span-2"><span>排除关键词</span><input value={criteria.excludedTerms} onChange={event => update("excludedTerms", event.target.value)} disabled={!!busy} maxLength={120} placeholder="多个词用逗号分隔；未知留空" /><small>根据已确认的业务反馈填写，避免一次未回复就排除整个市场。</small></label>
        </div>
        {!!plan?.customsHints?.length && <details className="bd-customs-hints" open><summary><FileText size={16} /><strong>参考客户的海关资料</strong><span>{plan.customsHintCount || plan.customsHints.length} 条关联原文</span><ChevronDown size={15} /></summary><p>逐项选择要采用的条件；货描仅供核对，不会自动发送给搜索服务。</p><div className="bd-customs-list">{plan.customsHints.map(hint => <article className="bd-customs-row" key={hint.id}>
          <div className="bd-customs-source"><strong>{hint.sourceName || "未填写来源名称"}{hint.sourceRow != null ? ` · 第 ${hint.sourceRow} 行` : " · 源行号未提供"}</strong><span className={`bd-tag ${hint.dataClass === "synthetic" ? "is-waiting" : ""}`}>{hint.dataClass === "synthetic" ? "示例资料" : "已导入资料"}</span></div>
          <div className="bd-customs-original"><span>原始 HS：<code>{hint.hsCode || "未提供"}</code></span><span>原始国家 / 地区：{hint.country || "未提供"}</span></div><p className="bd-customs-description">货描：{hint.description || "未提供"}</p>
          <div className="bd-customs-actions"><Button disabled={!!busy || !hint.hsCode.trim() || hint.hsCode.length > 40 || !hint.hsAssessment.formatValid || (hint.hsAssessment.options.length > 0 && hint.hsAssessment.options.every(option => !option.supported))} onClick={() => update("hsCode", hint.hsCode)}>采用此 HS</Button>{hint.hsAssessment.options.map(option => <Button key={option.category} disabled={!!busy || !option.supported} onClick={() => adoptCategory(option.category)}>{option.supported ? `采用${option.label}` : `${option.label} · 暂不支持`}</Button>)}{!!hint.country.trim() && <Button disabled={!!busy} onClick={() => update("targetMarket", hint.country)}>将此国家用于搜索</Button>}</div>
          {!hint.hsAssessment.formatValid && <p className="bd-hs-problem">原码格式需核对，未自动修复或采用。</p>}
        </article>)}</div></details>}
        {!!plan?.seedHints.length && <details className="bd-technical"><summary><FileText size={15} />查看参考条件的来源</summary>{plan.seedHints.map((hint,index) => <p key={index}>{hint}</p>)}</details>}
        <div className="bd-form-actions"><Button onClick={prepare} busy={busy === "plan"} disabled={!!busy || !criteria.buyerRoles.length || !!hsProblem}><SlidersHorizontal size={16} />{plan ? "更新搜索条件" : "准备搜索条件"}</Button><span>{planStale ? "条件已修改，请先更新下方搜索词。" : "先预览搜索词，再发起外部请求。"}</span></div>
        {plan && <div className="bd-plan"><h4><Globe2 size={17} />将发送的公开搜索词</h4><ul className="bd-queries">{plan.queries.map((query,index) => <li key={index}><code>{query}</code></li>)}</ul>{plan.warnings.map((warning,index) => <p className="bd-role-note" key={index}>{warning}</p>)}<label className="bd-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={!!busy || planStale} /><span>我已核对这些搜索条件，确认只包含可公开使用的业务信息。</span></label><div className="bd-plan-foot"><span>最多 {plan.limits.queries} 次搜索 · {plan.limits.resultsPerQuery} 条/次 · 深查 {plan.limits.inspectPerRun} 家</span><Button variant="primary" onClick={search} busy={busy === "search"} disabled={!!busy || !confirmed || planStale || !!hsProblem}><Search size={16} />开始真实搜索</Button></div><p className="bd-role-note">搜索通过独立 Tavily Key；未配置时保留条件，可手工导入企业官网。配置保存不代表真实搜索验证成功。</p></div>}
      </section>}
      {run && <section className="bd-section" ref={resultsRef}>
        <div className="bd-heading"><div><h3>新发现的候选网站</h3><p>{runStatus(run.status)} · {formatDate(run.finishedAt || run.startedAt,true)}{cached ? " · 已保存记录" : ""}</p></div><span className={`bd-tag ${run.status === "complete" ? "is-ready" : "is-waiting"}`}>当前还未确认采购需求</span></div>
        {runStale && <div className="bd-message is-warning"><AlertCircle size={18} /><span>搜索条件已修改，旧候选不能继续核验或保存。请按新条件搜索，或到历史记录重新打开这一次任务。</span></div>}
        {run.status === "failed" && <div className="bd-message is-warning" role="status"><AlertCircle size={18} /><span>{run.queries.find(query => query.status === "failed" && query.message)?.message || "搜索服务未返回可用结果，请展开查询记录核对原因。"}{run.queries.some(query => query.providerCode === "daily_cap_reached") && " 可到设置中的“自动搜索连接”配置自己的 Tavily Key。"}</span></div>}
        <div className="bd-run-summary"><div><span>搜索返回</span><strong>{run.stats.returned}<small>条</small></strong></div><div><span>新候选网站</span><strong>{run.candidates.length}<small>个</small></strong></div><div><span>已有客户 / 参考客户</span><strong>{run.stats.existingCompanies + run.stats.seedMatches}<small>条</small></strong></div><div><span>已投入官网核验</span><strong>{run.inspectionCount}<small>/ {inspectLimit} 家</small></strong></div></div>
        {run.candidates.length ? <div className="bd-candidates">{run.candidates.map(candidate => <Candidate key={candidate.id} candidate={candidate} expanded={expandedId === candidate.id} onExpand={() => setExpandedId(current => current === candidate.id ? "" : candidate.id)} busy={busy} disabled={runStale || !!busy} inspectLimitReached={run.inspectionCount >= inspectLimit} inspectLimit={inspectLimit} pageLimit={pageLimit} onInspect={() => inspect(candidate)} onReassess={() => reassess(candidate)} onSave={name => save(candidate,name)} onOpenCompany={onOpenCompany} justSaved={receipt?.candidateId === candidate.id} />)}</div> : <div className="bd-empty"><Search size={26} /><strong>{run.status === "failed" ? "本次没有取得有效搜索结果" : "当前条件下没有新的候选网站"}</strong><p>{run.status === "failed" ? "查看下面的失败原因。接口失败不会被展示为搜索成功。" : "相关结果可能已在客户库、重复或不符合公开网站要求。可核对搜索词后调整，不会自动放宽条件。"}</p></div>}
        <details className="bd-technical"><summary><FileText size={16} />查看搜索来源、去重与请求记录<ChevronDown size={15} /></summary><p>提供方：{run.provider} · 重复域名 {run.stats.duplicateDomains} 条 · 排除 {run.stats.excluded} 条 · 本流程模型调用 {run.modelCalls} 次。</p><p>{run.notice}</p>{run.queries.map((query,index) => <div className="bd-query-log" key={index}><strong>{query.query}</strong><p>{query.status === "complete" ? `成功返回 ${query.resultCount} 条` : query.status === "failed" ? `未完成：${query.message || query.errorCode || "请检查连接"}` : "尚未返回"}{typeof query.durationMs === "number" ? ` · ${Math.round(query.durationMs / 100) / 10} 秒` : ""}</p><SearchQueryDiagnostics query={query} />{query.requestId && <p>请求编号：{query.requestId}</p>}</div>)}<p>任务编号：{run.id}</p></details>
      </section>}
      {manualBasis && <section className="bd-manual-path" aria-label="手动继续获客"><div className="bd-heading"><div><h3>手动继续找新公司</h3><p>打开搜索网站，自己找到企业后再单独建档。原搜索状态与失败记录保留，不代表自动搜索已恢复。</p></div></div>
        {manualLinksDisabled && <p className="bd-manual-warning" role="status">{busy ? "当前操作进行中，搜索链接暂不可用。" : "条件已修改或尚未确认，下面的链接暂不可用。请先更新并确认上方搜索词。"}</p>}
        <div className="bd-manual-queries">{manualQueries.map((query, index) => <div className="bd-manual-query" key={`${index}:${query}`}><code>{query}</code><div>{([ ["Google", "https://www.google.com/search?q="], ["Bing", "https://www.bing.com/search?q="] ] as const).map(([label, base]) => manualLinksDisabled ? <span key={label} aria-disabled="true">{label}<ArrowUpRight size={14} /></span> : <a key={label} href={`${base}${encodeURIComponent(query)}`} target="_blank" rel="noopener noreferrer">在 {label} 搜索<ArrowUpRight size={14} /></a>)}</div></div>)}</div>
        <div className="bd-manual-create"><Button variant="primary" onClick={() => { setError(""); setManualCreateOpen(true); }} disabled={!!busy}><Plus size={16} />新建待核验客户</Button><p>填写新公司的名称，官网可暂时留空。保存后打开新客户详情，再查找官网或研究网站；不会把新网址写入参考客户。</p></div>
      </section>}
    </>}
    {tab === "history" && <section className="bd-section"><div className="bd-heading"><div><h3>{seedCompany.name} 的搜索记录</h3><p>重新打开保留的候选与引用，不会自动再次请求搜索服务。</p></div><Button onClick={refreshHistory} busy={busy === "refresh"} disabled={!!busy}><RefreshCw size={16} />刷新历史</Button></div>{history.length ? <div className="bd-history">{history.map(item => <article className="bd-history-card" key={item.id}><div><strong>{categoryName(item.criteria.category)} · {item.criteria.targetMarket || "全球"}</strong><p>{runStatus(item.status)} · {item.candidates.length} 个候选 · 已核验 {item.inspectionCount} 家</p><p>{formatDate(item.startedAt,true)} · 保存为真实公开搜索记录</p></div><Button onClick={() => restore(item)} disabled={!!busy}>打开这次搜索</Button></article>)}</div> : <div className="bd-empty"><History size={26} /><strong>还没有搜索记录</strong><p>先核对条件并开始一次真实搜索。搜索成功、部分成功与失败都会如实保留。</p></div>}</section>}
    <footer className="bd-footer"><span><ShieldCheck size={16} />新客户需人工确认 · 公开信息不等于采购承诺</span><Button onClick={close} disabled={!!busy}>完成</Button></footer>
  </div></Modal>;
}

function Candidate({ candidate, expanded, onExpand, busy, disabled, inspectLimitReached, inspectLimit, pageLimit, onInspect, onReassess, onSave, onOpenCompany, justSaved }: { candidate: DiscoveryCandidate; expanded: boolean; onExpand: () => void; busy: string; disabled: boolean; inspectLimitReached: boolean; inspectLimit: number; pageLimit: number; onInspect: () => void; onReassess: () => void; onSave: (name: string) => void; onOpenCompany: (companyId: string) => void; justSaved: boolean }) {
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState(false);
  useEffect(() => { setIdentity(false); }, [candidate.candidateHash]);
  const inspected = !!candidate.inspectedAt;
  const source = (id: string) => candidate.evidence.find(item => item.id === id);
  const stateLabel = candidate.savedCompanyId ? "已在客户库" : ({ unverified: "只有搜索摘要", inspecting: "正在读取官网", related_evidence: "产品与角色有依据", needs_evidence: "仍有依据待补", blocked: "官网未读到" }[candidate.status] || "待核验");
  const canSave = inspected && !!candidate.candidateHash && candidate.evidence.length > 0 && !candidate.savedCompanyId;
  return <article className={`bd-candidate ${inspected ? "is-inspected" : ""}`}>
    <div className="bd-candidate-header"><div className="bd-candidate-identity"><h4>{candidate.title || candidate.domain}</h4><div className="bd-candidate-domain"><ExternalLink url={candidate.url}>{candidate.domain}</ExternalLink><span>网页标题 · 企业名称待人工确认</span></div></div><div className="bd-candidate-heading-actions"><span className={`bd-tag ${candidate.status === "related_evidence" || candidate.savedCompanyId ? "is-ready" : candidate.status === "blocked" ? "is-error" : "is-waiting"}`}>{stateLabel}</span>{!inspected && <Button onClick={onInspect} busy={busy === `inspect:${candidate.id}`} disabled={disabled || inspectLimitReached || candidate.status === "inspecting"}><BookOpenCheck size={15} />核验官网</Button>}{inspected && candidate.evidence.length > 0 && <Button onClick={onReassess} busy={busy === `reassess:${candidate.id}`} disabled={disabled || candidate.status === "inspecting"}><RefreshCw size={15} />重新核对已存原文</Button>}</div></div>
    <div className="bd-candidate-body">
      {candidate.prescreen?.basis === "search_snippet" && <div className={`bd-prescreen is-${candidate.prescreen.priority}`}><strong>摘要初筛 · {{ first: "建议优先核验", normal: "可继续核验", later: "建议稍后核验" }[candidate.prescreen.priority]}</strong><span>仅安排核验顺序，尚未确认买家资格。</span>{candidate.prescreen.reasons.length > 0 && <ul>{candidate.prescreen.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}</div>}
      <div className="bd-source-type"><Search size={14} /><strong>搜索结果摘录</strong><span>尚不能替代官网核验</span></div><p className="bd-search-snippet">{candidate.searchSnippet || "搜索服务未提供摘录，请核对原始网页。"}</p>
      <details className="bd-candidate-details" open={expanded} onToggle={event => { if (event.currentTarget.open !== expanded) onExpand(); }}><summary><FileText size={15} />查看原文依据与待补项<ChevronDown size={15} /></summary>
        {candidate.searchSnippet && <div className="bd-evidence-box bd-search-full"><h5><Search size={15} />搜索摘录全文</h5><blockquote>{candidate.searchSnippet}</blockquote><p>发现于 {formatDate(candidate.discoveredAt,true)} · 搜索摘录不等于已读取官网。</p></div>}
        {candidate.evidence.length > 0 ? <><div className="bd-evidence-grid"><div className="bd-evidence-box"><h5><CheckCircle2 size={16} />产品关联</h5>{candidate.productEvidence.length ? candidate.productEvidence.map((item,index) => <div className="bd-quote" key={index}><blockquote>{item.quote}</blockquote><ExternalLink url={source(item.sourceId)?.url}>{item.relationship === "same_code" ? "同编号引用 · 适配未确认" : "商用车制动品类引用"}</ExternalLink></div>) : <p>读取的原文还不足以确认对应产品。不能仅凭公司介绍相似判断。</p>}</div><div className="bd-evidence-box"><h5><Building2 size={16} />买家角色</h5>{candidate.roleEvidence.length ? candidate.roleEvidence.map((item,index) => <div className="bd-quote" key={index}><blockquote>{item.quote}</blockquote><ExternalLink url={source(item.sourceId)?.url}>角色原文 · 当前采购计划未知</ExternalLink></div>) : <p>尚未找到该企业承担进口、分销或采购的直接依据。</p>}</div></div><div className="bd-source-list">{candidate.evidence.map(item => <div key={item.id}><ExternalLink url={item.url}>{item.title || "已读取网页原文"}</ExternalLink><time>{formatDate(item.capturedAt,true)}</time></div>)}</div><details className="bd-technical"><summary>展开已保存的官网原文<ChevronDown size={14} /></summary>{candidate.evidence.map(item => <div className="bd-query-log" key={item.id}><strong>{item.title || item.url}</strong><p>{item.snippet}</p></div>)}</details></> : <p className="bd-role-note">先点击“核验官网”，读取实际网页。每轮最多新核验 {inspectLimit} 家，每家最多读取 {pageLimit} 页。</p>}
        {inspected && <CandidateContacts candidate={candidate} />}
        {!!candidate.unknowns.length && <ul className="bd-gaps">{candidate.unknowns.map((item,index) => <li key={index}><AlertCircle size={15} />{item}</li>)}</ul>}
        {!!candidate.warnings.length && <ul className="bd-gaps">{candidate.warnings.map((item,index) => <li key={index}><AlertCircle size={15} />{item}</li>)}</ul>}
        {canSave && <div className="bd-save-box"><div className="bd-save-grid"><label className="bd-field"><span>确认企业名称</span><input value={name} onChange={event => { setName(event.target.value); setIdentity(false); }} placeholder="按企业官网核实后填写" maxLength={160} disabled={disabled} /></label><Button variant="primary" onClick={() => onSave(name)} busy={busy === `save:${candidate.id}`} disabled={disabled || !name.trim() || !identity}><Save size={15} />保存为待核验客户</Button></div><label className="bd-save-confirm"><input type="checkbox" checked={identity} onChange={event => setIdentity(event.target.checked)} disabled={disabled || !name.trim()} /><span>我已核对企业名称与这个网站的对应关系；产品、采购计划和付款能力仍以待补证项为准。</span></label><p className="bd-save-footnote">保存公开来源与核验依据。不会自动标为高意向客户，也不会发送消息。</p></div>}
        {candidate.savedCompanyId && <div className="bd-save-box"><p className="bd-save-footnote">{justSaved ? "保存已完成，原文与来源记录同时保留。" : "这条候选已经对应客户记录，无需重复建立。"}</p><Button onClick={() => onOpenCompany(candidate.savedCompanyId!)} disabled={disabled}><Building2 size={15} />打开客户继续研究</Button></div>}
      </details>
      {inspectLimitReached && !inspected && <p className="bd-role-note">本轮已达到 {inspectLimit} 家官网核验预算，其他搜索结果仍可打开原始网页核对。</p>}
    </div>
  </article>;
}

function CandidateContacts({ candidate }: { candidate: DiscoveryCandidate }) {
  return <section className="bd-public-contacts"><div className="bd-contact-title"><h5><Mail size={16} />官网公开联系入口</h5><span>岗位与接收人待确认</span></div>
    {candidate.contacts?.length ? <div className="bd-contact-grid">{candidate.contacts.map((contact, index) => {
      const value = contact.value.trim();
      let href: string | undefined;
      let label = contact.type === "email" ? "邮箱" : contact.type === "phone" ? "电话" : "网页联系入口";
      if (contact.type === "email" && /^[^\s<>"'@]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) href = `mailto:${encodeURIComponent(value).replace(/%40/g, "@")}`;
      if (contact.type === "phone" && /^\+?[\d().\s-]{5,40}$/.test(value)) href = `tel:${value.replace(/\s/g, "")}`;
      if (contact.type === "url") {
        href = safeUrl(value);
        if (href) {
          const hostname = new URL(href).hostname.toLowerCase();
          if (hostname === "wa.me" || hostname === "whatsapp.com" || hostname.endsWith(".whatsapp.com")) label = "WhatsApp";
        }
      }
      const source = candidate.evidence.find(item => item.url === contact.sourceUrl);
      return <article className="bd-public-contact" key={`${contact.type}:${value}:${index}`}><div className="bd-contact-kind">{contact.type === "email" ? <Mail size={15} /> : contact.type === "phone" ? <Phone size={15} /> : label === "WhatsApp" ? <MessageCircle size={15} /> : <Globe2 size={15} />}<strong>{label}</strong></div>{href ? <a className="bd-contact-value" href={href} {...(contact.type === "url" ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{value}</a> : <strong className="bd-contact-value">{value}</strong>}<p>{contact.role || "公开入口 · 岗位未确认"}</p><div className="bd-contact-source"><ExternalLink url={contact.sourceUrl}>来源网页</ExternalLink>{source?.capturedAt && <time>{formatDate(source.capturedAt,true)}</time>}</div></article>;
    })}</div> : <p className="bd-contact-empty">未从已读取页面取得联系入口。可打开原网页继续核对。</p>}
    {!!candidate.contacts?.length && <p className="bd-contact-note">公开入口不等于采购负责人；保存新客户时一并保留这些来源。</p>}
  </section>;
}
