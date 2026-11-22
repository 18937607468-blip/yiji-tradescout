"use client";

import { useState } from "react";
import { ArrowRight, ArrowUpRight, Building2, CalendarCheck2, ChevronRight, FileText, Globe2, History, ListFilter, MessageSquareText, Plus, Search, Upload } from "lucide-react";
import { Button, EmptyState } from "./PlatformUI";
import { PlatformState, formatDate, isDemoCompany, safeUrl } from "./types";
import type { DiscoveryCandidate, DiscoveryRun } from "./discovery-types";
import { CUSTOMS_PLATFORM_URL } from "@/lib/platform/customs-catalog.mjs";
import "./AcquisitionHome.css";

type Props = {
  state: PlatformState; loaded: boolean; busy: string;
  onStart: (companyId: string) => void; onResume: (companyId: string, runId: string) => void;
  onCreate: () => void; onLoadExample: () => void; onCustomers: () => void; onCustoms: () => void;
  onImport?: () => void; onWebsite?: () => void; onSocial?: () => void; onOpenCompany?: (id: string) => void;
};
type Filter = "all" | "unread" | "read" | "evidence" | "saved" | "followup" | "blocked";
type CandidateRow = { run: DiscoveryRun; candidate: DiscoveryCandidate };
const statuses: Record<string, string> = { complete: "搜索完成", partial: "部分成功", failed: "搜索失败", searching: "搜索中" };
const categories: Record<string, string> = { brake_lining: "鼓式刹车片", disc_brake_pad: "盘式刹车片", brake_shoe: "制动蹄" };
const sourceLabel = (company: PlatformState["companies"][number]) => company.dataClass === "synthetic" ? "演示样例" : "来源案例";
const validDate = (value?: string) => !!value && Number.isFinite(Date.parse(value));
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

export default function AcquisitionHome({ state, loaded, busy, onStart, onResume, onCreate, onLoadExample, onCustomers, onCustoms, onImport, onWebsite, onSocial, onOpenCompany }: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(10);
  const [historyFilter, setHistoryFilter] = useState<"recent" | "failed">("recent");
  const selected = selectedId ? state.companies.find(company => company.id === selectedId) : state.companies[0];
  const companies = new Map(state.companies.map(company => [company.id, company]));
  const followupIds = new Set(state.tasks.filter(task => task.status === "open").map(task => task.companyId));
  const runs = ((state.discoveryRuns || []) as unknown as DiscoveryRun[])
    .filter(run => run.dataClass === "real" && Array.isArray(run.candidates))
    .sort((a, b) => time(b.startedAt) - time(a.startedAt));
  const rows: CandidateRow[] = runs.flatMap(run => run.candidates.map(candidate => ({ run, candidate })));
  const savedCompany = (row: CandidateRow) => row.candidate.savedCompanyId ? companies.get(row.candidate.savedCompanyId) : undefined;
  const hasSaved = (row: CandidateRow) => { const company = savedCompany(row); return !!company && !isDemoCompany(company); };
  const hasEvidence = (row: CandidateRow) => row.candidate.evidence?.length > 0;
  const hasFollowup = (row: CandidateRow) => { const company = savedCompany(row); return hasSaved(row) && !!company && (validDate(company.nextFollowUpAt) || followupIds.has(company.id)); };
  const matchesFilter = (row: CandidateRow, value: Filter) => value === "all" ||
    (value === "unread" && ["unverified", "inspecting"].includes(row.candidate.status) && !hasEvidence(row) && !hasSaved(row)) ||
    (value === "read" && hasEvidence(row)) || (value === "evidence" && hasEvidence(row) && !hasSaved(row)) ||
    (value === "saved" && hasSaved(row)) || (value === "followup" && hasFollowup(row)) ||
    (value === "blocked" && row.candidate.status === "blocked");
  const count = (value: Filter) => rows.filter(row => matchesFilter(row, value)).length;
  const search = query.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => matchesFilter(row, filter) && (!search || [row.candidate.title, row.candidate.domain, row.candidate.searchSnippet, row.run.seedName, row.run.criteria.targetMarket, categories[row.run.criteria.category]].join(" ").toLocaleLowerCase().includes(search)));
  const domains = new Set(rows.map(row => row.candidate.domain).filter(Boolean));
  const domainCounts = rows.reduce((map, row) => map.set(row.candidate.domain, (map.get(row.candidate.domain) || 0) + 1), new Map<string, number>());
  const failedRuns = runs.filter(run => run.status === "failed" || run.status === "partial");
  const recent = (historyFilter === "failed" ? failedRuns : runs).slice(0, 6);
  const chooseFilter = (value: Filter) => { setFilter(value); setLimit(10); };
  const filters: Array<{ id: Filter; label: string }> = [
    { id: "all", label: "全部候选" }, { id: "unread", label: "待读官网" },
    { id: "read", label: "已读官网" }, { id: "evidence", label: "待确认" }, { id: "saved", label: "已保存" },
    { id: "followup", label: "有跟进安排" }, { id: "blocked", label: "读取失败" },
  ];
  const stages: Array<{ filter: Filter; label: string; total: number; note: string }> = [
    { filter: "all", label: "发现候选", total: rows.length, note: "搜索返回" },
    { filter: "read", label: "取得官网原文", total: rows.filter(hasEvidence).length, note: "已保存记录也计入" },
    { filter: "saved", label: "人工保存", total: rows.filter(hasSaved).length, note: "关联实际客户档案" },
    { filter: "followup", label: "已有跟进安排", total: rows.filter(hasFollowup).length, note: "有日期或待办事项" },
  ];

  return <div className="acq-home">
    <section className="acq-launch" aria-label="获客入口与真实流程">
      <div className="acq-entry">
        <div className="acq-entry-title"><span className="acq-kicker">从已有线索，找到下一批</span><span className="acq-entry-caption">产品 × 目标市场 × 采购角色</span></div>
        <div className="acq-reference">
          <label className="acq-field"><span>参考客户</span><select aria-label="选择参考客户" value={selected?.id || ""} onChange={event => setSelectedId(event.target.value)} disabled={!loaded || !!busy || !state.companies.length}>
            {!selected && <option value="">{loaded ? "请选择一个参考客户" : "正在读取…"}</option>}
            {state.companies.map(company => <option key={company.id} value={company.id}>{company.name}{isDemoCompany(company) ? ` · ${sourceLabel(company)}` : ""}</option>)}
          </select></label>
          <Button variant="primary" onClick={() => selected ? onStart(selected.id) : onCreate()} disabled={!loaded || !!busy}><Search size={17} />{selected ? "找新买家" : "添加参考客户"}<ArrowRight size={15} /></Button>
        </div>
        <div className="acq-reference-note"><span>{selected && isDemoCompany(selected) ? `${sourceLabel(selected)}仅作参考；` : ""}下一步确认产品、国家与角色后，才开始搜索。</span>{state.companies.length > 0 ? <button onClick={onCreate} disabled={!!busy || !loaded}><Plus size={13} />添加参考</button> : <button onClick={onLoadExample} disabled={!!busy || !loaded}><FileText size={13} />载入来源案例</button>}</div>
        <div className="acq-entry-grid">
          <button className="acq-entry-link" onClick={onCustoms} disabled={!loaded || !!busy}><span className="acq-entry-icon sage"><ListFilter size={18} /></span><span><strong>海关编码</strong><small>用 HS 编码找客户</small></span><ChevronRight size={15} /></button>
          <button className="acq-entry-link" onClick={onWebsite || onCreate} disabled={!loaded || !!busy}><span className="acq-entry-icon mist"><Globe2 size={18} /></span><span><strong>已有企业官网</strong><small>先建档，再读取官网原文</small></span><ChevronRight size={15} /></button>
          <button className="acq-entry-link" onClick={onImport} disabled={!loaded || !!busy || !onImport}><span className="acq-entry-icon mist"><Upload size={18} /></span><span><strong>导入客户名单</strong><small>从现有资料开始</small></span><ChevronRight size={15} /></button>
          <button className="acq-entry-link" onClick={onSocial} disabled={!loaded || !!busy || !onSocial}><span className="acq-entry-icon lilac"><MessageSquareText size={18} /></span><span><strong>整理社媒线索</strong><small>手动提供，先确认再保存</small></span><ChevronRight size={15} /></button>
        </div>
        <div className="acq-entry-footer"><span>公开搜索与规则初筛不调用 B1X。</span><a href={CUSTOMS_PLATFORM_URL} target="_blank" rel="noopener noreferrer">海关数据平台<ArrowUpRight size={13} /></a></div>
      </div>
      <div className="acq-flow">
        <div className="acq-flow-heading"><h2>先筛一批，再查重点。</h2><span>{loaded ? `${runs.length} 次真实搜索` : "正在读取"}</span></div>
        <div className="acq-flow-body"><svg className="acq-funnel" viewBox="0 0 102 194" fill="none" aria-hidden="true"><path d="M9 11C34 4 70 4 94 11L78 54L64 91L59 127V164L45 184V127L39 91L25 54L9 11Z" fill="currentColor" fillOpacity=".08" stroke="currentColor" strokeOpacity=".3"/><path d="M10 11C32 19 71 19 93 11M24 53C41 60 65 60 79 53M39 92C47 96 58 96 65 92" stroke="currentColor" strokeOpacity=".25"/><g fill="currentColor" fillOpacity=".45"><circle cx="32" cy="31" r="3"/><circle cx="52" cy="26" r="3.5"/><circle cx="73" cy="33" r="2.5"/><circle cx="43" cy="43" r="2"/><circle cx="63" cy="47" r="2.5"/><circle cx="45" cy="72" r="3"/><circle cx="60" cy="78" r="2.5"/><circle cx="51" cy="110" r="3.5"/></g><circle cx="51" cy="153" r="4" fill="#b78c5c"/></svg><div className="acq-flow-stages">{stages.map((stage, index) => <button key={stage.label} className={`acq-flow-stage acq-flow-stage-${index}${filter === stage.filter ? " is-active" : ""}`} aria-pressed={filter === stage.filter} onClick={() => chooseFilter(stage.filter)} disabled={!loaded} title={stage.note}><span className="acq-flow-number">0{index + 1}</span><span>{stage.label}</span><strong>{loaded ? stage.total : "—"}</strong><ChevronRight size={13} /></button>)}</div></div>
        <p className="acq-flow-note">同一候选范围 · 阶段可重叠，不代表转化率。<br />点击阶段查看对应记录；已保存可继续人工跟进。</p>
      </div>
    </section>

    <section className="acq-results" aria-labelledby="acq-results-title">
      <header className="acq-results-heading"><div><h2 id="acq-results-title">待开发的买家线索 <span>{loaded ? rows.length : "—"}</span></h2><p>{loaded ? `${domains.size} 个候选网站（域名去重）` : "正在读取候选"} · 候选身份与需求仍需核验</p></div><Button onClick={onCustomers} disabled={!loaded || !!busy}><Building2 size={15} />客户库</Button></header>
      <div className="acq-filter-bar"><div className="acq-filters" aria-label="筛选候选阶段">{filters.map(item => <button key={item.id} className={filter === item.id ? "is-active" : ""} aria-pressed={filter === item.id} onClick={() => chooseFilter(item.id)}>{item.label}<span>{loaded ? count(item.id) : "—"}</span></button>)}</div><label className="acq-list-search"><Search size={15} /><input aria-label="搜索当前候选记录" placeholder="公司、网站或目标市场" value={query} onChange={event => { setQuery(event.target.value); setLimit(10); }} /></label></div>
      {filtered.length ? <><div className="acq-table-scroll"><table className="acq-candidate-table"><thead><tr><th>候选网站 / 来源</th><th>为什么继续看</th><th>当前状态</th><th><span className="ts-sr-only">操作</span></th></tr></thead><tbody>{filtered.slice(0, limit).map(row => {
        const { candidate, run } = row;
        const seedExists = companies.has(run.seedCompanyId);
        const company = savedCompany(row);
        const citedQuote = candidate.productEvidence?.[0] || candidate.roleEvidence?.[0];
        const citedSource = citedQuote ? candidate.evidence?.find(item => item.id === citedQuote.sourceId) : undefined;
        const evidence = citedSource || candidate.evidence?.find(item => item.type === "webpage" && item.snippet) || candidate.evidence?.[0];
        const quote = citedSource ? citedQuote?.quote : evidence?.snippet;
        const reason = quote || candidate.prescreen?.reasons?.[0] || candidate.searchSnippet || "搜索未提供可用摘要，请先读取官网。";
        const source = safeUrl(evidence?.url || candidate.url);
        const saved = hasSaved(row);
        const followup = hasFollowup(row);
        const stateLabel = followup ? "已安排跟进" : saved ? "已保存到客户库" : candidate.status === "blocked" ? "官网读取失败" : candidate.status === "inspecting" ? "正在读取" : hasEvidence(row) ? "有原文 · 待确认" : "搜索候选 · 未核验";
        const openRun = () => { if (seedExists && !busy) onResume(run.seedCompanyId, run.id); };
        return <tr key={`${run.id}:${candidate.id}`} onClick={openRun} className={seedExists && !busy ? "is-openable" : ""}>
          <td><button className="acq-candidate-name" onClick={event => { event.stopPropagation(); openRun(); }} disabled={!seedExists || !!busy}>{candidate.title || candidate.domain}</button><div className="acq-domain"><Globe2 size={12} />{candidate.domain || "域名待核对"}{(domainCounts.get(candidate.domain) || 0) > 1 && <span>多轮出现</span>}</div><p className="acq-row-meta">目标市场：{run.criteria.targetMarket || "全球"} · {formatDate(run.startedAt, true)}</p><p className="acq-row-meta">参考：{run.seedName}</p></td>
          <td><span className={`acq-evidence-label ${quote ? "has-evidence" : ""}`}>{quote ? "官网原文依据" : "搜索摘要 / 规则初筛"}</span><p className="acq-reason" title={reason}>{reason}</p><div className="acq-evidence-source">{source && <a href={source} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()}>查看来源<ArrowUpRight size={12} /></a>}{evidence?.capturedAt && <span>{formatDate(evidence.capturedAt, true)}</span>}</div></td>
          <td><span className={`acq-candidate-status ${saved ? "saved" : candidate.status === "blocked" ? "blocked" : hasEvidence(row) ? "observed" : ""}`}>{stateLabel}</span><p className="acq-state-detail">{followup && company ? validDate(company.nextFollowUpAt) ? `跟进 ${formatDate(company.nextFollowUpAt, true)}` : "有未完成跟进事项" : candidate.status === "blocked" ? candidate.warnings?.[0] || "未取得足够原文，可查看详情" : saved ? "保存不代表已联系或成交" : candidate.unknowns?.[0] || "需求与采购联系人待确认"}</p>{candidate.savedCompanyId && !company && <p className="acq-state-detail">原关联档案不在当前客户库</p>}</td>
          <td className="acq-row-action">{company && onOpenCompany ? <Button variant="quiet" onClick={event => { event.stopPropagation(); onOpenCompany(company.id); }} disabled={!!busy}><CalendarCheck2 size={15} />打开客户</Button> : <Button variant="quiet" onClick={event => { event.stopPropagation(); openRun(); }} disabled={!!busy || !seedExists}>{hasEvidence(row) ? "核对依据" : "查看候选"}<ChevronRight size={15} /></Button>}{!seedExists && <span className="acq-state-detail">参考客户已不在库</span>}</td>
        </tr>;
      })}</tbody></table></div>{filtered.length > limit && <div className="acq-load-more"><Button variant="quiet" onClick={() => setLimit(value => value + 10)}>再看 10 条 · 共 {filtered.length} 条</Button></div>}</> : <EmptyState compact icon={<Search size={25} />} title={!loaded ? "正在读取候选记录" : rows.length ? "当前筛选下没有候选" : "还没有搜索候选"} description={rows.length ? "调整阶段或关键词，查看已有真实记录。" : "上方选择参考客户开始搜索。若已有公司名称或官网，也可以直接建档核验。"}>{rows.length > 0 && <Button variant="quiet" onClick={() => { chooseFilter("all"); setQuery(""); }}>清除筛选</Button>}</EmptyState>}
      <p className="acq-scope-note">仅统计真实搜索产生的候选记录，同一网站在不同轮次可能重复；手工官网核验、导入与来源案例不计入本表。</p>
    </section>

    <section className="acq-history" aria-labelledby="acq-history-title"><header className="acq-history-heading"><h2 id="acq-history-title"><History size={17} />搜索任务</h2><div className="acq-history-tabs"><button className={historyFilter === "recent" ? "is-active" : ""} onClick={() => setHistoryFilter("recent")} aria-pressed={historyFilter === "recent"}>最近任务 <span>{runs.length}</span></button><button className={historyFilter === "failed" ? "is-active" : ""} onClick={() => setHistoryFilter("failed")} aria-pressed={historyFilter === "failed"}>有失败记录 <span>{failedRuns.length}</span></button></div></header>
      {recent.length ? <div className="acq-history-list">{recent.map(run => { const seedExists = companies.has(run.seedCompanyId); const error = run.queries?.find(item => item.status === "failed"); return <article key={run.id}><span className={`acq-status ${run.status}`}>{statuses[run.status] || "状态待确认"}</span><div className="acq-run-main"><h3>{categories[run.criteria.category] || run.criteria.category}<span>目标市场：{run.criteria.targetMarket || "全球"}</span></h3><p>参考 {run.seedName} · {formatDate(run.startedAt, true)} · {run.candidates.length} 条候选{error?.message ? ` · ${error.message}` : ""}</p></div><Button variant="quiet" onClick={() => onResume(run.seedCompanyId, run.id)} disabled={!!busy || !seedExists}>{run.status === "failed" ? "查看失败与备用入口" : "继续查看"}<ChevronRight size={14} /></Button>{!seedExists && <span className="acq-state-detail">参考客户已不在库</span>}</article>; })}</div> : <div className="acq-history-empty">{historyFilter === "failed" ? "当前没有记录到失败的搜索任务。" : "搜索记录会保留在这里，包括失败与零候选任务。"}</div>}
      <p className="acq-history-note">打开已有任务不会自动重复搜索。执行结果以真实请求记录为准。</p>
    </section>
  </div>;
}
