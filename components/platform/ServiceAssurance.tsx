"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, FileCheck2, FileText, History, MessageSquareText, Save, ShieldCheck } from "lucide-react";
import { detectCustomerSignals } from "@/lib/platform/customer-signals.mjs";
import { Button, ExternalLink } from "./PlatformUI";
import { formatDate } from "./types";
import type { CommitmentAssessment, CommitmentRecord, InquiryRecord } from "./inquiry-types";
import "./ServiceAssurance.css";

type Kind = CommitmentAssessment["kind"];
type Action = (type: string, payload: Record<string, unknown>) => Promise<void>;
type Props = { sourceText: string; inquiry?: InquiryRecord; records: CommitmentRecord[]; needsSave: boolean; busy: string; onAction: Action };
const KINDS: Record<Kind, string> = { reply_update: "答复更新", dispatch: "发货承诺", price_reference: "参考价格" };

export default function ServiceAssurance({ sourceText, inquiry, records, needsSave, busy, onAction }: Props) {
  const signals = useMemo(() => detectCustomerSignals(sourceText || ""), [sourceText]);
  const [kind, setKind] = useState<Kind>("reply_update");
  const [owner, setOwner] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const [due, setDue] = useState("");
  const [checking, setChecking] = useState(false);
  const [assessment, setAssessment] = useState<CommitmentAssessment | null>(null);
  const [assessmentBasis, setAssessmentBasis] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const savedRecords = records.filter(record => record.inquiryId === inquiry?.id);
  const rechecks = savedRecords.filter(record => record.needsRecheck || record.currentAssessment?.status === "blocked").length;
  const candidates = inquiry?.analysis.candidates || [];
  const locked = !inquiry || needsSave || !!busy || checking;
  const request = useMemo(() => ({ companyId: inquiry?.companyId || "", inquiryId: inquiry?.id || "", expectedRevision: inquiry?.revision, kind, owner: owner.trim(), candidateId: candidateId || undefined, dueAt: due && Number.isFinite(Date.parse(due)) ? new Date(due).toISOString() : "" }), [inquiry?.companyId, inquiry?.id, inquiry?.revision, kind, owner, candidateId, due]);
  const basis = JSON.stringify({ request, sourceText: inquiry?.sourceText || "", inputs: inquiry?.inputs });
  const outdated = !!assessment && (needsSave || assessmentBasis !== basis);
  useEffect(() => {
    requestRef.current?.abort(); setAssessment(null); setAssessmentBasis(""); setError(""); setNotice("");
    setOwner(inquiry?.owner || ""); setCandidateId(""); setDue("");
  }, [inquiry?.id]);
  useEffect(() => () => requestRef.current?.abort(), []);

  const check = async () => {
    if (locked) return;
    setError(""); setNotice(""); setChecking(true);
    const sentBasis = basis; requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/platform/inquiry-assurance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: controller.signal });
      const body = await response.json() as { ok?: boolean; result?: CommitmentAssessment; error?: { message?: string } };
      if (!response.ok || !body.ok || !body.result) throw new Error(body.error?.message || "本次承诺核验未完成，请重试。");
      setAssessment(body.result); setAssessmentBasis(sentBasis);
    } catch (cause) { setError(cause instanceof Error && cause.name === "AbortError" ? "核验请求超时，未形成新的承诺结论。" : cause instanceof Error ? cause.message : "承诺核验未完成。"); }
    finally { clearTimeout(timeout); setChecking(false); }
  };
  const save = async () => {
    if (locked || !assessment || outdated) return; setError(""); setNotice("");
    try { await onAction("save_commitment", { ...request, reviewed: true }); setAssessment(null); setAssessmentBasis(""); setNotice("核验草案已保存，负责人、来源和配置均已留档；没有发送给客户，也没有预留库存。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "核验草案未能保存，请重试。"); }
  };

  return <details className="assurance-panel"><summary className="assurance-summary"><span className="assurance-summary-icon"><ShieldCheck size={22} /></span><div><strong>关注点与承诺核验</strong><p>从客户原话看关注点，承诺有依据，责任能回查。</p></div><span className={`assurance-badge ${rechecks ? "needs-review" : ""}`}>{rechecks ? `${rechecks} 条待复查` : signals.length ? `${signals.length} 项关注点待确认` : "展开核验"}</span><ChevronDown size={17} /></summary>
    <div className="assurance-body">
      <section className="assurance-signals"><div className="assurance-section-title"><MessageSquareText size={17} /><h3>原文里明确表达的关注点</h3><span>规则识别 · 待销售确认</span></div>{signals.length ? <div className="assurance-signal-grid">{signals.map((signal, index) => <article key={`${signal.kind}-${index}`}><span>{signal.label}</span><blockquote>{signal.quote}</blockquote></article>)}</div> : <p className="assurance-note">当前原文未命中明确的关注点词句。请按客户实际表达判断，关怀回复中的顾虑可以手动选择。</p>}<p className="assurance-note">标签只引用原话，不判断客户真实情绪，也不按国家推断偏好。</p></section>
      <div className="assurance-check-grid"><section><div className="assurance-section-title"><FileCheck2 size={17} /><h3>核对准备告诉客户的事项</h3></div>{(!inquiry || needsSave) && <p className="assurance-status-note">{!inquiry ? "先保存这条询价，再核验与留存承诺。" : "当前询价有未保存或未重新核验的条件，请先保存。"}</p>}<div className="assurance-fields">
        <label><span>事项类型</span><select value={kind} onChange={event => { setKind(event.target.value as Kind); setDue(""); setError(""); setNotice(""); }} disabled={checking || !!busy}>{Object.entries(KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>责任人</span><input value={owner} onChange={event => setOwner(event.target.value)} maxLength={100} placeholder="由谁核对和负责" /></label>
        <label className="assurance-span"><span>当前候选件号{kind !== "reply_update" ? " · 必选" : " · 可选"}</span><select value={candidateId} onChange={event => setCandidateId(event.target.value)}><option value="">请选择当前询价的候选</option>{candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.namespace} {candidate.partNumber}</option>)}</select></label>
        {kind !== "price_reference" && <label className="assurance-span"><span>{kind === "dispatch" ? "准备承诺的发货时间" : "准备答复更新的时间"}</span><input value={due} onChange={event => setDue(event.target.value)} type="datetime-local" /><small>按当前设备时区保存。只核验这项计划，不会自动发送或安排发货。</small></label>}
      </div><Button variant="primary" onClick={check} disabled={locked} busy={checking}><ShieldCheck size={16} />核验依据与承诺</Button></section>
        <section className="assurance-result" aria-live="polite">{assessment ? <><div className={`assurance-result-title ${assessment.status === "blocked" || outdated ? "is-blocked" : ""}`}>{assessment.status === "blocked" || outdated ? <AlertCircle size={19} /> : <CheckCircle2 size={19} />}<strong>{outdated ? "条件已变化，需要重查" : assessment.status === "blocked" ? "依据待补，暂不能据此承诺" : "依据齐备，可供人工复核"}</strong></div>{outdated && <p className="assurance-note">客户资料、配置、负责人或日期发生变化；旧核验结果已停止使用。</p>}{assessment.blockers.length > 0 && <ul className="assurance-blockers">{assessment.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>}<EvidenceList assessment={assessment} /><div className="assurance-result-meta"><span>责任人：{assessment.owner || "待确认"}</span><span>核验时间：{formatDate(assessment.checkedAt, true)}</span></div><p className="assurance-note">这是未发送草案；答复计划不代表已回复，发货依据不代表已锁库存。</p><Button onClick={save} disabled={locked || outdated} busy={busy === "save_commitment"}><Save size={16} />保存核验草案</Button></> : <div className="assurance-result-empty"><ShieldCheck size={30} /><strong>承诺前，先把依据补齐</strong><p>发货需要有效库存、材质、单位和可发日期；价格只采用本条询价下可比的历史参考。</p></div>}</section>
      </div>
      {error && <p className="assurance-error" role="alert">{error}</p>}{notice && <p className="assurance-success" role="status">{notice}</p>}
      <details className="assurance-supply"><summary><FileText size={16} /><span>补录企业供货依据</span><ChevronDown size={15} /></summary><p className="assurance-note">只录入企业授权的实际资料；系统不会自动生成库存或交货日期。</p>{inquiry && !needsSave ? <SupplyReferenceForm key={inquiry.id} inquiry={inquiry} busy={!!busy} onAction={onAction} onSaved={() => { setAssessmentBasis(""); setNotice("供货依据已保存，请重新核验准备承诺的事项。"); }} /> : <p className="assurance-status-note">保存当前询价后可录入，并绑定当前规格和客户。</p>}</details>
      <section className="assurance-history"><div className="assurance-section-title"><History size={17} /><h3>责任与依据留档</h3><span>{savedRecords.length} 条草案 · 未发送</span></div>{savedRecords.length ? [...savedRecords].reverse().map(record => <RecordTrace record={record} key={record.id} />) : <p className="assurance-note">保存后可回看谁在什么时间，依据哪条客户原话与哪版配置，做了哪项核验。</p>}</section>
    </div>
  </details>;
}

function EvidenceList({ assessment }: { assessment: CommitmentAssessment }) {
  return assessment.evidence?.length ? <details className="assurance-evidence"><summary>查看本次依据（{assessment.evidence.length}）</summary>{assessment.evidence.map((evidence, index) => <div key={evidence.id || index}><strong>{evidence.title}</strong>{evidence.quote && <blockquote>{evidence.quote}</blockquote>}{evidence.observedAt && <small>观察时间：{formatDate(evidence.observedAt, true)}</small>}{evidence.url && <ExternalLink url={evidence.url}>打开来源</ExternalLink>}</div>)}</details> : <p className="assurance-note">{assessment.kind === "reply_update" ? "答复计划核对责任人与未来答复时间，不使用库存或价格作为依据。" : "尚无可用于此事项的完整依据。"}</p>;
}

function RecordTrace({ record }: { record: CommitmentRecord }) {
  const current = record.currentAssessment || record.assessment;
  return <details className="assurance-trace"><summary><span>{KINDS[record.kind]} · {record.owner || "负责人待确认"}</span><time>{formatDate(record.createdAt, true)}</time><b className={record.needsRecheck || current.status === "blocked" ? "needs-review" : ""}>{record.needsRecheck ? "需重新核验" : current.status === "blocked" ? "待补依据" : "草案留档"}</b><ChevronDown size={14} /></summary><div><dl><div><dt>原询价版本</dt><dd>V{record.inquiryRevision}</dd></div><div><dt>约定计划时间</dt><dd>{record.dueAt ? formatDate(record.dueAt, true) : "未填写 / 不适用"}</dd></div><div><dt>记录范围</dt><dd>{record.dataClass === "synthetic" ? "资料练习 · 与真实业务隔离" : "当前客户与询价"}</dd></div></dl>{record.sourceText && <blockquote>{record.sourceText}</blockquote>}{record.sourceUrl && <ExternalLink url={record.sourceUrl}>原询价来源</ExternalLink>}{current.blockers?.length > 0 && <ul className="assurance-blockers">{current.blockers.map((item, index) => <li key={index}>{item}</li>)}</ul>}<EvidenceList assessment={current} /><p className="assurance-fingerprint">来源记录 {record.sourceFingerprint?.slice(0, 12)} · 配置记录 {record.inputFingerprint?.slice(0, 12)}</p></div></details>;
}

function SupplyReferenceForm({ inquiry, onAction, busy, onSaved }: { inquiry: InquiryRecord; onAction: Action; busy: boolean; onSaved: () => void }) {
  const [error, setError] = useState("");
  const [baseRevision, setBaseRevision] = useState(inquiry.revision);
  const formRef = useRef<HTMLFormElement>(null);
  const staleForm = inquiry.revision !== baseRevision;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy || staleForm) return; setError("");
    const form = new FormData(event.currentTarget); const value = (key: string) => String(form.get(key) || "").trim();
    const payload: Record<string, unknown> = { companyId: inquiry.companyId, inquiryId: inquiry.id, expectedRevision: baseRevision, candidateId: value("candidateId"), quantityAvailable: value("quantityAvailable"), unit: value("unit"), sourceTitle: value("sourceTitle"), sourceText: value("sourceText"), sourceUrl: value("sourceUrl"), authorized: true, dataClass: inquiry.dataClass || "real" };
    for (const key of ["observedAt", "validUntil", "earliestDispatchAt"]) {
      if (!value(key) || !Number.isFinite(Date.parse(value(key)))) { setError("请填写完整、有效的库存观察时间、依据有效期和最早可发时间。"); return; }
      payload[key] = new Date(value(key)).toISOString();
    }
    try { await onAction("add_supply_reference", payload); onSaved(); }
    catch(cause) { setError(cause instanceof Error ? cause.message : "供货依据尚未保存，输入已保留。"); }
  };
  return <form ref={formRef} className="assurance-supply-form" onSubmit={submit}>{staleForm && <div className="assurance-status-note">询价版本已更新，旧供货表不能写入新配置。<Button type="button" onClick={() => { formRef.current?.reset(); setBaseRevision(inquiry.revision); setError(""); }}>按当前版本重新填写</Button></div>}<div className="assurance-fields"><label><span>当前候选 *</span><select name="candidateId" required><option value="">请选择</option>{inquiry.analysis.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.namespace} {candidate.partNumber}</option>)}</select></label><label><span>记录绑定的材质</span><input readOnly value={inquiry.inputs.materialGrade || "未提供；请先补齐询价材质"} /></label><label><span>实际可供数量 *</span><input name="quantityAvailable" type="number" min="0" step="any" required /></label><label><span>库存计量单位 *</span><input name="unit" required defaultValue={inquiry.inputs.unit} placeholder="单位必须与采购口径可比" /></label><label><span>库存观察时间 *</span><input name="observedAt" type="datetime-local" required /></label><label><span>供货依据有效至 *</span><input name="validUntil" type="datetime-local" required /></label><label className="assurance-span"><span>最早可发时间 *</span><input name="earliestDispatchAt" type="datetime-local" required /><small>以上时间按当前设备时区保存；不将最早可发日期当成实际发货承诺。</small></label><label className="assurance-span"><span>来源名称 *</span><input name="sourceTitle" maxLength={200} required placeholder="库存确认单 / 生产排期确认" /></label><label className="assurance-span"><span>原始依据与责任确认 *</span><textarea name="sourceText" rows={3} maxLength={5000} required placeholder="保留企业确认人、实际库存与日期依据" /></label><label className="assurance-span"><span>来源链接</span><input name="sourceUrl" type="url" maxLength={2048} /></label><label className="assurance-consent assurance-span"><input type="checkbox" required /><span>{inquiry.dataClass === "synthetic" ? "这条资料用于隔离的练习场景，不能作为实际供货承诺。" : "我确认企业授权使用此实际供货依据，且信息与本次询价规格一致。"}</span></label></div>{error && <p className="assurance-error" role="alert">{error}</p>}<Button type="submit" busy={busy} disabled={busy || staleForm || !inquiry.inputs.materialGrade}><Save size={16} />保存供货依据</Button></form>;
}
