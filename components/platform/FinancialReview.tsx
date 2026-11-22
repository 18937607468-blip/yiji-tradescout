"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { AlertCircle, BookOpenCheck, Calculator, CheckCircle2, ChevronDown, FileCheck2, FileText, History, Info, Save, ShieldCheck, Sparkles } from "lucide-react";
import { Button, ExternalLink, Modal } from "./PlatformUI";
import { Company, PlatformState } from "./types";
import type { FinancialDataClass, FinancialExtraction, FinancialExtractionField, FinancialMetric, FinancialNumberField, FinancialReport, FinancialReviewResult, FinancialSavedRecord, FinancialSaveMeta } from "./financial-types";
import "./FinancialReview.css";

type Props = { state: PlatformState; initialCompanyId?: string; onClose: () => void; onSaved: (state: Partial<PlatformState>, meta: FinancialSaveMeta) => void };
type Form = { companyId: string; sourceText: string; sourceName: string; sourcePage: string; sourceUrl: string; authorized: boolean; dataClass: FinancialDataClass | ""; reviewer: string; report: FinancialReport; confirmations: { identity: boolean; basis: boolean } };
type Response = { ok?: boolean; result?: FinancialReviewResult | FinancialExtraction; data?: Partial<PlatformState>; meta?: FinancialSaveMeta; error?: { message?: string } };
const MAX_TEXT = 16000;
const SCALES: Record<string, string> = { "1": "元 / 原币单位", "1000": "千", "10000": "万", "1000000": "百万" };
const FIELD_LABELS: Record<keyof FinancialReport, string> = { entityName: "报表主体", entityRelation: "主体与客户关系", scope: "单体 / 合并范围", balanceDate: "资产负债表日", periodStart: "报告期开始", periodEnd: "报告期结束", currency: "币种", scale: "金额单位", currentAssets: "流动资产", currentLiabilities: "流动负债", operatingCashFlow: "经营活动现金流量净额", netIncome: "净利润" };
const NUMBER_FIELDS: Array<{ field: FinancialNumberField; code: string; note: string }> = [{ field: "currentAssets", code: "CA", note: "资产负债表日的余额，不能用总资产代替。" }, { field: "currentLiabilities", code: "CL", note: "同一报表日的余额，不能用总负债代替。" }, { field: "operatingCashFlow", code: "CFO", note: "报告期的净额，保留负数；不填期末现金余额。" }, { field: "netIncome", code: "NI", note: "同一报告期、同一主体范围的净利润。" }];
const classFor = (company?: Company): FinancialDataClass => company?.dataClass === "synthetic" || company?.isDemo === true ? "synthetic" : "real";
const emptyReport = (): FinancialReport => ({ entityName: "", entityRelation: "unknown", scope: "unknown", balanceDate: "", periodStart: "", periodEnd: "", currency: "", scale: "", currentAssets: "", currentLiabilities: "", operatingCashFlow: "", netIncome: "" });
const makeForm = (company?: Company): Form => ({ companyId: company?.id || "", sourceText: "", sourceName: "", sourcePage: "", sourceUrl: "", authorized: false, dataClass: company ? classFor(company) : "", reviewer: "", report: emptyReport(), confirmations: { identity: false, basis: false } });
const sourceFingerprint = (form: Form) => JSON.stringify({ companyId: form.companyId, sourceText: form.sourceText, sourceName: form.sourceName, sourcePage: form.sourcePage, sourceUrl: form.sourceUrl, authorized: form.authorized, dataClass: form.dataClass });
const displayFieldValue = (field: keyof FinancialReport, value: string) => field === "scope" ? ({ standalone: "单体报表", consolidated: "合并报表", unknown: "待确认" }[value] || value) : field === "scale" ? SCALES[value] || value : value;
const canApplyExtraction = (field: FinancialExtractionField) => field.field === "scope" ? ["standalone", "consolidated", "unknown"].includes(field.value) : field.field === "scale" ? Object.prototype.hasOwnProperty.call(SCALES, field.value) : true;
const dateTime = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "保存时间待确认" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date); };
const moneyUnit = (currency?: string, scale?: string) => `${currency || "币种待确认"} · ${SCALES[scale || ""] || "单位待确认"}`;
const readableNumber = (value: string) => { const [integer, decimal] = value.split("."); return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${decimal === undefined ? "" : `.${decimal}`}`; };
const readableMessage = (message: string) => Object.entries(FIELD_LABELS).reduce((text, [field, label]) => text.replaceAll(field, label), message);

export default function FinancialReview({ state, initialCompanyId, onClose, onSaved }: Props) {
  const [form, setForm] = useState<Form>(() => makeForm(state.companies.find(company => company.id === initialCompanyId)));
  const [tab, setTab] = useState<"review" | "history">("review");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<FinancialReviewResult | null>(null);
  const [reviewFingerprint, setReviewFingerprint] = useState("");
  const [extraction, setExtraction] = useState<FinancialExtraction | null>(null);
  const [extractionFingerprint, setExtractionFingerprint] = useState("");
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [appliedFields, setAppliedFields] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<FinancialSaveMeta | null>(null);
  const [historyCompany, setHistoryCompany] = useState(initialCompanyId || "");
  const [clearConfirm, setClearConfirm] = useState(false);
  const textInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const records = (state.financialReviews || []) as unknown as FinancialSavedRecord[];
  const companies = state.companies.filter(company => classFor(company) === form.dataClass);
  const currentFingerprint = JSON.stringify(form);
  const reviewStale = !!result && reviewFingerprint !== currentFingerprint;
  const extractStale = !!extraction && extractionFingerprint !== sourceFingerprint(form);
  const compatibleCompany = state.companies.find(company => company.id === form.companyId);
  const canUseModel = !!state.capabilities.modelConfigured;
  useEffect(() => () => controller.current?.abort(), []);

  const clearNotice = () => { setReceipt(null); setNotice(""); setError(""); };
  const update = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm(current => ({ ...current, [key]: value, confirmations: { identity: false, basis: false }, ...(["sourceText", "sourceName", "sourcePage", "sourceUrl", "dataClass"].includes(key) ? { authorized: false } : {}) }));
    if (["sourceText", "sourceName", "sourcePage", "sourceUrl", "companyId", "dataClass"].includes(key)) setSelectedFields([]);
    clearNotice();
  };
  const updateReport = <K extends keyof FinancialReport>(key: K, value: FinancialReport[K]) => {
    setForm(current => ({ ...current, report: { ...current.report, [key]: value }, confirmations: { identity: false, basis: false } }));
    setAppliedFields(current => current.filter(field => field !== key)); clearNotice();
  };
  const changeClass = (value: FinancialDataClass | "") => {
    setForm(current => ({ ...current, dataClass: value, companyId: classFor(state.companies.find(company => company.id === current.companyId)) === value ? current.companyId : "", authorized: false, confirmations: { identity: false, basis: false } }));
    setSelectedFields([]); clearNotice();
  };
  const confirm = (field: "identity" | "basis", value: boolean) => { setForm(current => ({ ...current, confirmations: { ...current.confirmations, [field]: value } })); clearNotice(); };
  const readText = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    if (!/\.txt$/i.test(file.name) || file.size > 128 * 1024) { setError("请选择 UTF-8 TXT（最多 128 KB），仅保留相关财报原文；PDF 或图片请先复制可核对的文字。旧内容已保留。"); event.target.value = ""; return; }
    setBusy("read"); setError("");
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()).replace(/^\uFEFF/, "");
      if (!value.trim() || value.length > MAX_TEXT) throw new Error("原文需有内容且最多 16,000 字符，请截取对应页再读取。");
      setForm(current => ({ ...current, sourceText: value, sourceName: current.sourceName || file.name, authorized: false, confirmations: { identity: false, basis: false } }));
      setSelectedFields([]); setAppliedFields([]); setReceipt(null); setNotice("TXT 已读取，尚未保存。请核对表头年份、币种、金额单位和报表主体。");
    } catch(cause) { setError(cause instanceof Error && cause.name !== "TypeError" ? cause.message : "无法按 UTF-8 读取。请另存 UTF-8 TXT 或直接粘贴原文；旧内容已保留。"); }
    finally { setBusy(""); event.target.value = ""; }
  };
  const validateSource = () => {
    if (!form.companyId || !compatibleCompany) return "请先选择已有客户企业；这项核验用于少量核心客户。";
    if (!form.dataClass || classFor(compatibleCompany) !== form.dataClass) return "请选择与客户一致的真实 / 测试资料类别。";
    if (!form.sourceName.trim() || !form.sourcePage.trim()) return "请补充财报来源名称和页码 / 章节，方便复核原件。";
    if (!form.sourceText.trim() || form.sourceText.length > MAX_TEXT) return "请录入 1–16,000 字符的可核对财报原文；PDF 与图片本轮不直接解析。";
    if (!form.authorized) return "请确认原文来自公开财报，或你有权使用这份企业资料。";
    return "";
  };
  const request = async (payload: Record<string, unknown>, mode: string): Promise<Response> => {
    const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), mode === "extract" ? 35000 : 30000);
    try {
      const response = await fetch("/api/platform/financial-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: abort.signal });
      const body = await response.json() as Response;
      if (!response.ok || !body.ok) throw new Error(body.error?.message || "财务核验请求未完成，请重试。输入已保留。");
      return body;
    } catch(cause) {
      throw new Error(cause instanceof Error && cause.name === "AbortError" ? mode === "save" ? "保存请求超时，实际保存状态暂不确定。输入已保留，请查看历史或刷新后核对再重试。" : "请求超时，没有生成新的有效结果。输入已保留，请检查连接后重试。" : cause instanceof Error ? cause.message : "请求失败，输入已保留。");
    } finally { clearTimeout(timeout); }
  };
  const extract = async () => {
    if (busy) return; const invalid = validateSource(); if (invalid) { setError(invalid); return; }
    if (!canUseModel) { setError("请先在当前账号配置模型 Key，再使用 AI 提取；也可以直接人工录入四项数值。"); return; }
    setBusy("extract"); clearNotice();
    try {
      const body = await request({ mode: "extract", companyId: form.companyId, sourceText: form.sourceText, sourceName: form.sourceName, sourcePage: form.sourcePage, sourceUrl: form.sourceUrl, authorized: true, dataClass: form.dataClass }, "extract");
      const next = body.result as FinancialExtraction | undefined;
      if (!next || !Array.isArray(next.fields) || next.status !== "pending_review") throw new Error("提取响应不完整，没有自动填入任何字段。");
      setExtraction(next); setExtractionFingerprint(sourceFingerprint(form)); setSelectedFields([]); setAppliedFields([]);
      setNotice("已获得待核对的 AI 建议。逐项对照原文与表头年份后勾选；不会自动填表或计算。");
    } catch(cause) { setError(cause instanceof Error ? cause.message : "提取未完成，没有使用示例结果。"); }
    finally { setBusy(""); }
  };
  const applyExtraction = () => {
    if (!extraction || extractStale || !selectedFields.length || busy) return;
    const picked = extraction.fields.filter(field => selectedFields.includes(field.field) && canApplyExtraction(field));
    const next = { ...form.report };
    for (const field of picked) {
      if (!Object.prototype.hasOwnProperty.call(FIELD_LABELS, field.field) || field.field === ("entityRelation" as string)) continue;
      if (field.field === "scope" && !["standalone", "consolidated", "unknown"].includes(field.value)) continue;
      Object.assign(next, { [field.field]: field.value });
    }
    setForm(current => ({ ...current, report: next, confirmations: { identity: false, basis: false } }));
    setAppliedFields(picked.map(field => field.field)); setSelectedFields([]); setReceipt(null); setError("");
    setNotice(`已填入 ${picked.length} 项人工选中的建议。请继续核对报表主体、同一期别与金额单位，再进行公式核验。`);
  };
  const review = async () => {
    if (busy) return; const invalid = validateSource(); if (invalid) { setError(invalid); return; }
    if (!form.reviewer.trim()) { setError("请填写审核人，保存核验记录时需要保留责任来源。"); return; }
    setBusy("review"); clearNotice();
    try {
      const body = await request({ ...form, mode: "review" }, "review");
      const next = body.result as FinancialReviewResult | undefined;
      if (!next?.reviewHash || !next.metrics) throw new Error("核验响应不完整，没有可保存的新结果。");
      setResult(next); setReviewFingerprint(currentFingerprint);
      setNotice(next.status === "incomplete" ? "已核验当前资料，尚有待补项。缺数据不代表客户无力付款，可以保存待补记录。" : "已按核对后的口径完成公式核验。这里只记录历史财务事实，不自动改变客户分级或授信。");
    } catch(cause) { setError(cause instanceof Error ? cause.message : "核验未完成，输入已保留。"); }
    finally { setBusy(""); }
  };
  const save = async () => {
    if (busy || !result || reviewStale) return;
    setBusy("save"); setError(""); setNotice("");
    try {
      const body = await request({ ...form, mode: "save", reviewHash: result.reviewHash }, "save");
      if (!body.data || !body.meta?.id) throw new Error("保存响应不完整，请刷新后核对历史记录。输入已保留。");
      onSaved(body.data, body.meta); setReceipt(body.meta); setNotice(body.meta.duplicate ? "相同核验已保存，没有重复新增记录。" : "核验记录已保存，原文、主体口径、审核人和公式结果可在历史中回看。");
    } catch(cause) { setError(cause instanceof Error ? cause.message : "保存未完成，输入已保留。"); }
    finally { setBusy(""); }
  };
  const reset = () => { setForm(makeForm(state.companies.find(company => company.id === form.companyId))); setResult(null); setReviewFingerprint(""); setExtraction(null); setExtractionFingerprint(""); setSelectedFields([]); setAppliedFields([]); setReceipt(null); setClearConfirm(false); setError(""); setNotice(""); };
  const close = () => { if (busy) { setError("操作仍在进行，请等待结果后再关闭，当前输入会保留。"); return; } onClose(); };

  return <Modal title="财务资料核验" description="把少量核心客户的财务资料核实清楚，保留主体、口径与来源。" onClose={close} wide><div className="financial-review-body">
    <div className="financial-tabs" role="tablist"><button role="tab" aria-selected={tab === "review"} className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}><FileCheck2 size={17} />录入与核验</button><button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}><History size={17} />历史记录 <span>{records.length}</span></button></div>
    {error && <p className="financial-message error" role="alert"><AlertCircle size={18} />{error}</p>}{notice && <p className="financial-message" role="status"><CheckCircle2 size={18} />{notice}</p>}
    {tab === "review" ? <>
      <div className="financial-intro"><ShieldCheck size={25} /><div><strong>先确认是谁的报表，再读数字</strong><p>保留历史财务事实与缺项。母集团合并报表不能直接证明子公司有付款能力，缺少财报也不等于无力付款。</p></div></div>
      <section className="financial-section"><header><div className="financial-heading"><span className="financial-step">01</span><h3>留存资料来源</h3></div><input type="file" ref={textInput} accept=".txt,text/plain" hidden onChange={readText} disabled={!!busy} /><Button disabled={!!busy} busy={busy === "read"} onClick={() => textInput.current?.click()}><FileText size={16} />读取 TXT</Button></header>
        <div className="financial-fields"><label><span>资料类别 *</span><select value={form.dataClass} onChange={event => changeClass(event.target.value as FinancialDataClass | "")} disabled={!!busy}><option value="">请选择资料类别</option><option value="real">公开 / 授权的真实资料</option><option value="synthetic">测试 / 演示资料</option></select></label><label><span>关联客户 *</span><select value={form.companyId} onChange={event => update("companyId", event.target.value)} disabled={!!busy || !form.dataClass}><option value="">选择已有客户企业</option>{companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label><label><span>财报来源名称 *</span><input value={form.sourceName} onChange={event => update("sourceName", event.target.value)} disabled={!!busy} maxLength={200} placeholder="公司 2025 年度报告" /></label><label><span>页码 / 章节 *</span><input value={form.sourcePage} onChange={event => update("sourcePage", event.target.value)} disabled={!!busy} maxLength={200} placeholder="例如：第 45–47 页，财务报表" /></label><label className="financial-span"><span>原文链接 <small>可选</small></span><input type="url" value={form.sourceUrl} onChange={event => update("sourceUrl", event.target.value)} disabled={!!busy} maxLength={2048} placeholder="公开报告网址或经授权可回看的来源链接" /></label></div>
        <label className="financial-source-text"><span>可核对的财报原文 *</span><textarea value={form.sourceText} onChange={event => update("sourceText", event.target.value)} rows={7} disabled={!!busy} placeholder="粘贴相关页文字，保留报表主体、表头年份、币种与金额单位。双年度表请保留数值与年份的对应关系。" /><small>{form.sourceText.length.toLocaleString()} / 16,000 字符。支持粘贴、UTF-8 TXT 或复制 PDF 文字；本轮不直接解析 PDF / 图片。</small></label>
        <label className="financial-check"><input type="checkbox" checked={form.authorized} onChange={event => update("authorized", event.target.checked)} disabled={!!busy} /><span>{form.dataClass === "synthetic" ? "这是测试资料，将与真实客户资料区分保存。" : "原文来自公开财报，或我已获得使用授权；允许保存到当前独立工作空间。"}</span></label>
        <div className="financial-ai-row"><p>{canUseModel ? "可选：通过当前账号已配置的 B1X 模型提取待核对字段。只发送本次财报文字及来源信息。与官网研究、询价提取统一记录调用次数，可在设置中查看；结论需人工确认。" : "当前账号尚未配置模型 Key。可先人工录入四项数值，完成同样的公式核验与存证。"}</p><Button onClick={extract} disabled={!!busy || !canUseModel || form.sourceText.length > MAX_TEXT} busy={busy === "extract"}><Sparkles size={16} />AI 提取待核对字段</Button></div>
        {extraction && <div className="financial-extraction"><header><strong>逐项对照原文后采用</strong><span>{extraction.model} · {Math.max(0, extraction.elapsedMs / 1000).toFixed(1)} 秒</span></header><p>每一项都要核对对应年份与列位置。勾选即表示采用该值；已有不同值时会明确替换，未勾选的字段保持原样。</p>{extractStale ? <div className="financial-extract-stale">来源或关联客户已变更，这批建议已过期。请重新提取，或继续按当前原文人工填写。</div> : <><div className="financial-extract-fields">{extraction.fields.map(field => <ExtractionChoice key={field.field} field={field} current={form.report[field.field]} checked={selectedFields.includes(field.field)} applied={appliedFields.includes(field.field)} disabled={!!busy} onChange={checked => setSelectedFields(current => checked ? [...current, field.field] : current.filter(value => value !== field.field))} />)}</div>{!extraction.fields.length && <p>这次没有可可靠提取的字段。请人工核对原件，不会使用示例数字补全。</p>}<div className="financial-extract-actions"><span>{selectedFields.length} 项已人工选择</span><Button disabled={!!busy || !selectedFields.length} onClick={applyExtraction}>采用所选字段</Button></div></>}{extraction.unknowns?.length > 0 && <details className="financial-method"><summary><ChevronDown size={15} />提取中仍需人工核对的内容</summary><ul className="financial-fact-list">{extraction.unknowns.map((item, index) => <li key={index}>{readableMessage(item)}</li>)}</ul></details>}{extraction.requestId && <p className="financial-source-help">请求记录：{extraction.requestId} · 建议尚不等于已验证事实。</p>}</div>}
      </section>
      <section className="financial-section"><header><div className="financial-heading"><span className="financial-step">02</span><h3>核对主体与四项数值</h3></div></header>
        <div className="financial-fields"><label><span>报表主体名称</span><input value={form.report.entityName} onChange={event => updateReport("entityName", event.target.value)} disabled={!!busy} maxLength={200} placeholder="按报告封面与财务报表原名填写" /></label><label><span>报表主体与客户的关系</span><select value={form.report.entityRelation} onChange={event => updateReport("entityRelation", event.target.value as FinancialReport["entityRelation"])} disabled={!!busy}><option value="unknown">尚未确认</option><option value="customer">报表主体就是该客户</option><option value="parent_group">客户的母公司 / 所属集团</option><option value="other">其他主体</option></select></label><label><span>报表范围</span><select value={form.report.scope} onChange={event => updateReport("scope", event.target.value as FinancialReport["scope"])} disabled={!!busy}><option value="unknown">待确认单体 / 合并</option><option value="standalone">单体报表</option><option value="consolidated">合并报表</option></select></label><label><span>资产负债表日</span><input type="date" value={form.report.balanceDate} onChange={event => updateReport("balanceDate", event.target.value)} disabled={!!busy} /></label><label><span>现金流 / 净利润报告期开始</span><input type="date" value={form.report.periodStart} onChange={event => updateReport("periodStart", event.target.value)} disabled={!!busy} /></label><label><span>现金流 / 净利润报告期结束</span><input type="date" value={form.report.periodEnd} onChange={event => updateReport("periodEnd", event.target.value)} disabled={!!busy} /></label><label><span>币种</span><input value={form.report.currency} onChange={event => updateReport("currency", event.target.value.toUpperCase())} maxLength={3} disabled={!!busy} placeholder="原文币种：USD / CNY / EUR" /></label><label><span>原文金额单位</span><select value={form.report.scale} onChange={event => updateReport("scale", event.target.value)} disabled={!!busy}><option value="">尚未确认</option>{Object.entries(SCALES).map(([value, label]) => <option value={value} key={value}>{label}{value !== "1" ? `（× ${Number(value).toLocaleString()}）` : "（× 1）"}</option>)}</select></label></div>
        {(form.report.scope === "consolidated" || form.report.entityRelation === "parent_group") && <p className="financial-basis-note">这里核验的是所填报表主体的资料。集团或合并数据覆盖的范围与具体采购客户可能不同，不代表该客户可直接支配这些资产或现金。</p>}
        <p className="financial-unit-note">四个数都按上面同一币种与单位填写，不另行换算。未知请留空；0 是已核对的零值。经营现金流和净利润可填负数，括号按负数处理。</p>
        <div className="financial-values">{NUMBER_FIELDS.map(({ field, code, note }) => <div className="financial-value" key={field}><label><span>{FIELD_LABELS[field]} <small>{code}</small></span><input value={form.report[field]} onChange={event => updateReport(field, event.target.value)} disabled={!!busy} inputMode="decimal" maxLength={80} placeholder="未知留空，例如 1,250.50" /><small>{note}</small></label>{appliedFields.includes(field) && !extractStale && <p className="financial-value-note">已采用人工勾选的 AI 建议；引用可在上方展开核对。</p>}</div>)}</div>
        <div className="financial-fields" style={{ marginTop: 17 }}><label><span>审核人 *</span><input value={form.reviewer} onChange={event => update("reviewer", event.target.value)} disabled={!!busy} maxLength={100} placeholder="实际完成核对的人员" /></label></div>
        <div className="financial-confirmations"><label className="financial-check"><input type="checkbox" checked={form.confirmations.identity} onChange={event => confirm("identity", event.target.checked)} disabled={!!busy} /><span>已核对报表主体、它与客户的关系，以及单体 / 合并范围。尚不清楚时不勾选，保留待补。</span></label><label className="financial-check"><input type="checkbox" checked={form.confirmations.basis} onChange={event => confirm("basis", event.target.checked)} disabled={!!busy} /><span>已将所填数字与原文逐项核对，确认报表日期、报告期、币种和单位一致，未把双年度表的不同列混用。</span></label></div>
        <div className="financial-review-row"><p>公式由服务器按已确认口径计算。资料不全时给出缺项，也可保存待补记录。</p><Button variant="primary" disabled={!!busy || form.sourceText.length > MAX_TEXT} busy={busy === "review"} onClick={review}><Calculator size={16} />{result ? "重新核验当前资料" : "核验当前资料"}</Button></div>
      </section>
      {result && <section className={`financial-section financial-result ${reviewStale ? "stale" : ""}`}><header><div className="financial-heading"><span className="financial-step">03</span><h3>{reviewStale ? "条件已变化，旧核验失效" : "核验结果与下一步"}</h3></div><span className={`financial-status ${reviewStale || result.status === "incomplete" ? "pending" : ""}`}>{reviewStale ? "需重新核验" : result.status === "incomplete" ? "资料待补" : "公式已核验"}</span></header>{reviewStale ? <p className="financial-result-caption">原文、主体口径、数值或确认状态发生变化。旧结果已撤回，重新核验后才能保存；请重新确认当前资料。</p> : <><p className="financial-result-caption">{result.report.entityName || "报表主体待核对"} · {result.report.scope === "consolidated" ? "合并报表" : result.report.scope === "standalone" ? "单体报表" : "报表范围待确认"}{result.report.balanceDate ? ` · 资产负债表日 ${result.report.balanceDate}` : ""}</p><Metrics result={result} />{!result.appliesToCustomer && <p className="financial-basis-note">这些数据不能直接作为当前客户的财务结论；请继续核对主体对应关系与报表范围。</p>}{result.missing.length > 0 && <div className="financial-missing"><h4>还需要补什么</h4><ul>{result.missing.map((item, index) => <li key={index}>{readableMessage(item)}</li>)}</ul></div>}{result.warnings.length > 0 && <ul className="financial-fact-list">{result.warnings.map((item, index) => <li key={index}>{readableMessage(item)}</li>)}</ul>}<p className="financial-source-help"><Info size={16} />{result.notice || "这是指定时点与期间的历史财务事实，不是付款保证、违约概率或自动授信建议。"}</p><details className="financial-method"><summary><BookOpenCheck size={15} />公式与解释范围</summary><p>流动比率 = 流动资产 ÷ 流动负债；营运资本 = 流动资产 − 流动负债。经营活动现金流量净额和净利润分别展示原文已核对数值，不增加信用评分。分母为零、日期或币种单位不明时，保留待核状态。</p><ExternalLink url="https://www.sec.gov/about/reports-publications/beginners-guide-financial-statements">SEC：财务报表入门</ExternalLink><ExternalLink url="https://occ.gov/publications-and-resources/publications/economics/on-point/pub-on-point-industries-recovering-unevenly.pdf">OCC：流动比率定义（第 2 页）</ExternalLink></details></>}
        <div className="financial-save-row"><p>{reviewStale ? "当前没有可保存的有效核验。" : "保存原文、口径、审核人及本次结果；不会修改客户分级。"}</p><Button variant="primary" onClick={save} busy={busy === "save"} disabled={!!busy || reviewStale}><Save size={16} />{result.status === "incomplete" ? "保存待补记录" : "保存核验记录"}</Button></div></section>}
      {receipt && <div className="financial-receipt" role="status"><CheckCircle2 size={20} /><div><strong>{receipt.duplicate ? "相同记录已存在" : "已保存，可回看核验依据"}</strong><p>输入仍保留。到“历史记录”可核对原文、日期、金额单位与审核人。</p><small>记录编号：{receipt.id}</small></div></div>}
      {clearConfirm ? <div className="financial-clear"><p>只清空当前未保存的输入，已存历史记录保留。</p><Button onClick={reset} disabled={!!busy}>确认清空</Button><Button variant="quiet" onClick={() => setClearConfirm(false)}>取消</Button></div> : <Button variant="quiet" disabled={!!busy} onClick={() => setClearConfirm(true)}>清空并录入下一份</Button>}
    </> : <section className="financial-history"><header><h3>可追溯的财务核验</h3><select aria-label="筛选财务核验客户" value={historyCompany} onChange={event => setHistoryCompany(event.target.value)}><option value="">全部客户</option>{state.companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></header>{records.filter(item => !historyCompany || item.companyId === historyCompany).length ? <div className="financial-history-list">{[...records].reverse().filter(item => !historyCompany || item.companyId === historyCompany).map(record => <HistoryRecord key={record.id} record={record} company={state.companies.find(company => company.id === record.companyId)} />)}</div> : <div className="financial-empty"><History size={32} /><strong>还没有保存的核验记录</strong><p>用公开或授权原文开始。数值不全也能留下来源与缺项，之后再补齐。</p><Button onClick={() => setTab("review")}>录入一份资料</Button></div>}</section>}
    <footer className="financial-footer"><span>原文有出处 · 主体有边界 · 核验有责任人</span><Button disabled={!!busy} onClick={close}>完成</Button></footer>
  </div></Modal>;
}

function ExtractionChoice({ field, current, checked, applied, disabled, onChange }: { field: FinancialExtractionField; current: string; checked: boolean; applied: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  const different = !!current && current !== "unknown" && current !== field.value;
  const direct = canApplyExtraction(field);
  return <label className="financial-extract-field"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled || !direct} /><div><strong>{FIELD_LABELS[field.field] || field.field}</strong><b>{displayFieldValue(field.field, field.value)}</b><blockquote>{field.quote}</blockquote>{field.basisQuote && <blockquote>期别 / 口径依据：{field.basisQuote}</blockquote>}{!direct && <small>保留原文词义供核对。请在下方“{field.field === "scope" ? "报表范围" : "原文金额单位"}”选择对应项，这一项不会自动填入。</small>}{different && direct && <small>采用后替换已填值：{displayFieldValue(field.field, current)}。请确认所取年份与列位置。</small>}{applied && !different && <small>已人工采用。再次修改该字段后仍需重新核验。</small>}</div></label>;
}

function Metric({ title, metric, kind, fallback }: { title: string; metric?: FinancialMetric; kind: "ratio" | "money"; fallback: { currency: string; scale: string } }) {
  const known = metric?.value !== null && metric?.value !== undefined && metric?.value !== "";
  const hasBase = metric?.baseValue !== null && metric?.baseValue !== undefined && metric?.baseValue !== "";
  const currency = metric?.currency || fallback.currency;
  const display = !known ? "待核对" : kind === "ratio" ? `${metric!.value} 倍` : `${currency} ${readableNumber(hasBase ? metric!.baseValue! : metric!.value!)}`;
  const explanation = metric?.status === "zero_denominator" ? "流动负债为 0，不能计算比率。" : !known ? "缺少相应数值或已确认口径。" : metric?.formula || (kind === "money" ? "主金额按报表单位换算为币种基本单位，未进行汇率换算。" : "按已核对的余额计算。");
  return <div className="financial-metric"><h4>{title}</h4><strong>{display}</strong><small>{kind === "ratio" ? "流动资产 / 流动负债" : `${known ? `原文单位数值 ${metric!.value} · ` : ""}${moneyUnit(currency, metric?.scale || fallback.scale)}`}</small><p>{explanation === "CA - CL" ? "流动资产 − 流动负债；主金额已换算为币种基本单位。" : explanation === "CA / CL" ? "流动资产 ÷ 流动负债。" : explanation}</p></div>;
}

function Metrics({ result }: { result: FinancialReviewResult }) {
  return <div className="financial-metrics"><Metric title="流动比率" metric={result.metrics.currentRatio} kind="ratio" fallback={result.report} /><Metric title="营运资本" metric={result.metrics.workingCapital} kind="money" fallback={result.report} /><Metric title="经营活动现金流量净额" metric={result.metrics.operatingCashFlow} kind="money" fallback={result.report} /><Metric title="净利润" metric={result.metrics.netIncome} kind="money" fallback={result.report} /></div>;
}

function HistoryRecord({ record, company }: { record: FinancialSavedRecord; company?: Company }) {
  return <article className="financial-history-item"><header><div><h4>{record.sourceName}</h4><small>{company?.name || "关联客户待核对"} · 报表主体：{record.report.entityName || "待补充"}</small></div><span className={`financial-data-tag ${record.dataClass === "synthetic" ? "synthetic" : ""}`}>{record.dataClass === "synthetic" ? "测试资料" : "真实资料"}</span></header><div className="financial-history-meta"><span>审核人：{record.reviewer}</span><span>保存于 {dateTime(record.createdAt)}</span><span>{record.sourcePage}</span><span>{record.report.scope === "consolidated" ? "合并报表" : record.report.scope === "standalone" ? "单体报表" : "范围待确认"}</span><span>{record.result.status === "incomplete" ? "资料待补" : "公式已核验"}</span></div><details><summary>查看原文、口径与保存结果</summary><p className="financial-source-help">资产负债表日：{record.report.balanceDate || "未知"}；现金流 / 净利润期间：{record.report.periodStart || "未知"} 至 {record.report.periodEnd || "未知"}；{moneyUnit(record.report.currency, record.report.scale)}。</p><p className="financial-source-help">主体关系：{{ customer: "报表主体就是客户", parent_group: "母公司 / 所属集团", other: "其他主体", unknown: "尚未确认" }[record.report.entityRelation]}；主体确认：{record.confirmations.identity ? "已人工核对" : "待核对"}；数字口径：{record.confirmations.basis ? "已人工核对" : "待核对"}。</p><Metrics result={record.result} /><div className="financial-history-values">{NUMBER_FIELDS.map(({ field }) => <div key={field}>{FIELD_LABELS[field]}：{record.report[field] || "未知"}</div>)}</div>{record.result.missing?.length > 0 && <div className="financial-missing"><h4>保存时的待补项</h4><ul>{record.result.missing.map((item, index) => <li key={index}>{readableMessage(item)}</li>)}</ul></div>}{record.result.warnings?.length > 0 && <ul className="financial-fact-list">{record.result.warnings.map((item, index) => <li key={index}>{readableMessage(item)}</li>)}</ul>}<blockquote>{record.sourceText}</blockquote>{record.sourceUrl && <ExternalLink url={record.sourceUrl}>查看原文链接</ExternalLink>}<p className="financial-source-help">此处为保存时的核验快照，不自动说明客户当前的付款能力。</p></details></article>;
}
