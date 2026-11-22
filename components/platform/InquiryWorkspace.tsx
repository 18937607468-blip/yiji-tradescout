"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowDownToLine, BookOpen, Calculator, CalendarClock, Check, CheckCircle2, ChevronDown, ClipboardList, Copy, FileCheck2, FileSearch, FileText, History, ImageIcon, Layers3, Plus, RefreshCw, Save, Search, SlidersHorizontal, Truck } from "lucide-react";
import { Button, ExternalLink, Modal } from "./PlatformUI";
import { PlatformState, formatDate, localInputDate, safeUrl } from "./types";
import { EMPTY_INQUIRY_INPUTS, FitmentCandidate, InquiryAnalysis, InquiryInputs, InquiryRecord, QuoteRange } from "./inquiry-types";
import CustomerCareReply from "./CustomerCareReply";
import ServiceAssurance from "./ServiceAssurance";
import MaterialCostCalculator, { MaterialSourceRequest } from "./MaterialCostCalculator";

type Props = {
  state: PlatformState; loaded: boolean; busy: string;
  onAction: (type: string, payload: Record<string, unknown>) => Promise<void>;
  onCreateCustomer: () => void;
};
const CHANNELS = ["MIC", "Facebook", "WhatsApp", "视频号", "邮件", "其他"];
const PART_TYPES = [["unknown", "待确认"], ["brake_lining", "鼓式衬片"], ["disc_brake_pad", "盘式刹车片"], ["brake_shoe", "制动蹄 / 总成"], ["wind_power", "风电制动片"]];
const NAMESPACES = [["unknown", "编号体系待确认"], ["WVA", "WVA"], ["OE", "OE / 原厂编号"], ["INTERNAL", "冠英内部编号"], ["BFMC", "BFMC"]];
const fingerprint = (value: InquiryInputs) => JSON.stringify(value);
const asText = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
type ExtractedField = { field: Exclude<keyof InquiryInputs, "dimensionUnitConfirmed">; value: string; quote: string };
type Extraction = { fields: ExtractedField[]; unknowns: string[]; model: string; requestId: string | null; elapsedMs: number };
const FIELD_NAMES: Record<string, string> = { partType: "制动件类型", codeNamespace: "编号体系", photoUrl: "照片或铭牌链接", dimensionUnitConfirmed: "目录尺寸单位确认", vehicleModel: "车型", axleBrand: "车桥品牌", axleModel: "车桥型号", year: "车桥制造年份", brakeSystem: "制动器型号", loadTons: "车桥额定轴荷", partCode: "现有件号", widthMm: "片宽（mm）", thicknessMm: "片厚（mm）", drumDiameterMm: "制动鼓直径（mm）", materialGrade: "材质等级", quantity: "采购数量", unit: "计价单位", currency: "币种", incoterm: "贸易条款", destination: "目的地", accessories: "附件口径", rawWidth: "目录片宽原值", rawThickness: "目录片厚原值", sizeCode: "规格标记原文" };

export default function InquiryWorkspace({ state, loaded, busy, onAction, onCreateCustomer }: Props) {
  const [inputs, setInputs] = useState<InquiryInputs>({ ...EMPTY_INQUIRY_INPUTS });
  const [selectedId, setSelectedId] = useState("");
  const [revision, setRevision] = useState<number | undefined>();
  const [companyId, setCompanyId] = useState("");
  const [channel, setChannel] = useState("MIC");
  const [sourceText, setSourceText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [owner, setOwner] = useState("");
  const [nextFollowUpAt, setNextFollowUpAt] = useState("");
  const [dataClass, setDataClass] = useState<"real" | "synthetic">("real");
  const [analysis, setAnalysis] = useState<InquiryAnalysis | null>(null);
  const [analysisBasis, setAnalysisBasis] = useState("");
  const [analysisCompany, setAnalysisCompany] = useState("");
  const [matchBusy, setMatchBusy] = useState(false);
  const [lastMatchMs, setLastMatchMs] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [confirmCandidate, setConfirmCandidate] = useState<FitmentCandidate | null>(null);
  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [extractBusy, setExtractBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [extractedChecked, setExtractedChecked] = useState<string[]>([]);
  const sourceTextRef = useRef(sourceText); sourceTextRef.current = sourceText;
  const pendingSave = useRef<{ previousIds: string[]; id: string; companyId: string; sourceText: string } | null>(null);
  const pendingQuoteRevision = useRef<string | null>(null);
  const pendingAssuranceRevision = useRef<string | null>(null);
  const pendingMaterialRevision = useRef<string | null>(null);
  const [materialContext, setMaterialContext] = useState(0);
  const [materialSourceRequest, setMaterialSourceRequest] = useState<(MaterialSourceRequest & { contextKey: string }) | null>(null);
  const materialRequestSequence = useRef(0);
  const materialPreviousBasis = useRef<{ id: string; basis: string } | null>(null);
  const [materialResetNotice, setMaterialResetNotice] = useState("");
  const matchSequence = useRef(0);
  const currentInputs = useRef(inputs); currentInputs.current = inputs;
  const requestController = useRef<AbortController | null>(null);
  const stale = !!analysis && (analysisBasis !== fingerprint(inputs) || analysisCompany !== companyId);
  const saving = busy === "save_inquiry";
  const disabled = !!busy || matchBusy || extractBusy || exportBusy || !loaded;
  const records = state.inquiries || [];
  const currentRecord = records.find(item => item.id === selectedId);
  const materialSavedBasis = JSON.stringify({ companyId, selectedId, inputs: currentRecord?.inputs || null, sourceText: currentRecord?.sourceText || "", sourceUrl: currentRecord?.sourceUrl || "", dataClass: currentRecord?.dataClass || dataClass });
  const materialContextKey = `${materialSavedBasis}:${materialContext}`;
  useEffect(() => {
    const previous = materialPreviousBasis.current;
    if (previous?.id && previous.id === selectedId && previous.basis !== materialSavedBasis) setMaterialResetNotice("询价条件已变化，请重新核算。当前草稿已按新询价重置，原材料核算保留在历史中。");
    else if (previous?.id !== selectedId) setMaterialResetNotice("");
    materialPreviousBasis.current = { id: selectedId, basis: materialSavedBasis };
  }, [selectedId, materialSavedBasis]);

  useEffect(() => () => requestController.current?.abort(), []);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  useEffect(() => {
    if (pendingMaterialRevision.current) {
      const updated = records.find(item => item.id === pendingMaterialRevision.current && item.revision !== revision);
      if (updated) {
        setRevision(updated.revision); setHistory(updated.history || []); setAnalysis(updated.analysis);
        setAnalysisBasis(fingerprint({ ...EMPTY_INQUIRY_INPUTS, ...updated.inputs })); setAnalysisCompany(updated.companyId);
        setLastMatchMs(null); pendingMaterialRevision.current = null;
      }
    }
    if (pendingAssuranceRevision.current) {
      const updated = records.find(item => item.id === pendingAssuranceRevision.current && item.revision !== revision);
      if (updated) {
        setRevision(updated.revision); setHistory(updated.history || []); setAnalysis(updated.analysis);
        setAnalysisBasis(fingerprint({ ...EMPTY_INQUIRY_INPUTS, ...updated.inputs })); setAnalysisCompany(updated.companyId);
        setLastMatchMs(null); pendingAssuranceRevision.current = null;
      }
    }
    if (pendingQuoteRevision.current) {
      const updated = records.find(item => item.id === pendingQuoteRevision.current && item.revision !== revision);
      if (updated) { setRevision(updated.revision); setHistory(updated.history || []); setAnalysisBasis(""); setLastMatchMs(null); pendingQuoteRevision.current = null; }
    }
    const pending = pendingSave.current;
    if (!pending) return;
    const record = records.find(item => pending.id ? item.id === pending.id && item.revision !== revision : !pending.previousIds.includes(item.id) && item.companyId === pending.companyId && item.sourceText === pending.sourceText);
    if (!record) return;
    pendingSave.current = null;
    setSelectedId(record.id); setRevision(record.revision);
    setAnalysis(record.analysis); setAnalysisBasis(fingerprint({ ...EMPTY_INQUIRY_INPUTS, ...record.inputs })); setAnalysisCompany(record.companyId);
    setHistory(record.history || []); setDirty(false); setLastMatchMs(null); setNotice("询价已保存；候选、依据与跟进安排可以继续查看。");
  }, [records, revision]);

  const setInput = (name: Exclude<keyof InquiryInputs, "dimensionUnitConfirmed">, value: string) => {
    setInputs(current => ({ ...current, [name]: value })); setDirty(true); setNotice(""); setError("");
  };
  const loadRecord = (id: string) => {
    setMaterialContext(value => value + 1); setMaterialSourceRequest(null); setMaterialResetNotice("");
    matchSequence.current += 1; requestController.current?.abort(); setMatchBusy(false);
    const record: InquiryRecord | undefined = records.find(item => item.id === id);
    setSelectedId(record?.id || ""); setRevision(record?.revision);
    const next = { ...EMPTY_INQUIRY_INPUTS, ...record?.inputs };
    setInputs(next); setCompanyId(record?.companyId || ""); setChannel(record?.channel || "MIC");
    setSourceText(record?.sourceText || ""); setSourceUrl(record?.sourceUrl || "");
    setOwner(record?.owner || ""); setNextFollowUpAt(localInputDate(record?.nextFollowUpAt || record?.followUpAt));
    setDataClass(record?.dataClass || "real"); setAnalysis(record?.analysis || null);
    setAnalysisBasis(record ? fingerprint(next) : ""); setAnalysisCompany(record?.companyId || ""); setHistory(record?.history || []);
    setDirty(false); setError(""); setNotice(""); setSwitchTarget(null); setLastMatchMs(null);
  };
  const switchRecord = (id: string) => { if (dirty) setSwitchTarget(id); else loadRecord(id); };
  const loadExample = () => {
    setMaterialContext(value => value + 1); setMaterialSourceRequest(null); setMaterialResetNotice("");
    const next = { ...EMPTY_INQUIRY_INPUTS, axleBrand: "BPW", axleModel: "MVB FST 10010", year: "2023", brakeSystem: "SN 4218", partType: "brake_lining" };
    setSelectedId(""); setRevision(undefined); setInputs(next); setCompanyId(""); setSourceUrl("https://www.bpw.de/fileadmin/user_upload/Service/Downloads/BPW-2025-Repair_kits_Spare_parts-Repsatz_31112501e.pdf");
    setSourceText("原厂资料核验练习：BPW MVB FST 10010，2023 年起，SN 4218 鼓式制动器。尚未提供衬片厚度。此记录不代表真实客户询价或冠英已确认适配。");
    setDataClass("synthetic"); setOwner(""); setNextFollowUpAt(""); setChannel("其他"); setAnalysis(null); setAnalysisBasis(""); setDirty(true); setHistory([]); setError(""); setNotice("已填入原厂资料案例。点击目录匹配，再补充厚度，查看候选如何变化。");
  };
  const match = async () => {
    if (disabled) return;
    setError(""); setNotice(""); setMatchBusy(true);
    const sequence = ++matchSequence.current; const started = performance.now();
    const sentInputs = { ...inputs }; const basis = fingerprint(sentInputs);
    requestController.current?.abort(); const controller = new AbortController(); requestController.current = controller;
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch("/api/platform/inquiry-match", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: sentInputs, companyId: companyId || undefined, inquiryId: selectedId || undefined, dataClass }), signal: controller.signal });
      const body = await response.json() as { ok?: boolean; result?: InquiryAnalysis; error?: { message?: string } };
      if (!response.ok || !body.ok || !body.result) throw new Error(body.error?.message || "本次目录匹配未完成，请重试。");
      if (sequence !== matchSequence.current) return;
      setAnalysis(body.result); setAnalysisBasis(basis); setAnalysisCompany(companyId); setLastMatchMs(performance.now() - started);
      if (basis !== fingerprint(currentInputs.current)) setNotice("查询期间条件有变化，请按当前条件重新匹配。");
    } catch (cause) {
      if (sequence !== matchSequence.current) return;
      setError(cause instanceof Error && cause.name === "AbortError" ? "本次查询超时。输入已保留，可重新匹配。" : cause instanceof Error ? cause.message : "目录匹配未完成。");
    } finally { clearTimeout(timer); if (sequence === matchSequence.current) setMatchBusy(false); }
  };
  const save = async () => {
    if (disabled) return; setError(""); setNotice("");
    if (!companyId) { setError("请先选择这条询价所属的客户。匹配可以先做，保存需要关联客户。"); return; }
    if (!sourceText.trim()) { setError("请保留一段客户询价原文，便于核对配型依据。"); return; }
    if (nextFollowUpAt && !Number.isFinite(Date.parse(nextFollowUpAt))) { setError("请检查跟进时间。"); return; }
    pendingSave.current = { previousIds: records.map(item => item.id), id: selectedId, companyId, sourceText: sourceText.trim() };
    try {
      await onAction("save_inquiry", { ...(selectedId ? { id: selectedId, expectedRevision: revision } : {}), companyId, channel, inputs, sourceText: sourceText.trim(), sourceUrl, owner, nextFollowUpAt: nextFollowUpAt ? new Date(nextFollowUpAt).toISOString() : "", dataClass });
    } catch (cause) { pendingSave.current = null; setError(cause instanceof Error ? cause.message : "未能保存，输入已保留。"); }
  };
  const copyQuestion = async () => {
    const text = (analysis?.questions || []).join("\n");
    if (!text || stale) return;
    try { await navigator.clipboard.writeText(text); setNotice("补问已复制，尚未发送给客户。"); }
    catch { setNotice("无法自动复制，请在下方选中补问文字手动复制。"); }
  };
  const extractSource = async () => {
    if (disabled || !state.capabilities.modelConfigured) return;
    if (!sourceText.trim()) { setError("请先粘贴客户询价原文，再提取其中明确说出的字段。"); return; }
    const text = sourceText; setExtractBusy(true); setError(""); setNotice("");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 28000);
    try {
      const response = await fetch("/api/platform/inquiry-extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceText: text, companyId: companyId || undefined }), signal: controller.signal });
      const body = await response.json() as { ok?: boolean; result?: Extraction; error?: { message?: string } };
      if (!response.ok || !body.ok || !body.result) throw new Error(body.error?.message || "原文提取未完成，未使用预设结果替代。");
      if (text !== sourceTextRef.current) throw new Error("提取期间原文已变化，请用当前原文重新提取。");
      setExtraction(body.result); setExtractedChecked([]);
    } catch (cause) { setError(cause instanceof Error && cause.name === "AbortError" ? "模型请求超时。未应用任何字段，请检查运行记录后重试。" : cause instanceof Error ? cause.message : "提取未完成。"); }
    finally { clearTimeout(timer); setExtractBusy(false); }
  };
  const applyExtracted = () => {
    const patch: Partial<InquiryInputs> = {};
    for (const item of extraction?.fields || []) if (extractedChecked.includes(item.field) && item.field in EMPTY_INQUIRY_INPUTS && item.field !== ("dimensionUnitConfirmed" as string)) patch[item.field] = item.value;
    setInputs(current => ({ ...current, ...patch })); setDirty(true); setAdvancedOpen(true); setExtraction(null);
    setNotice(`已填入 ${Object.keys(patch).length} 个确认字段；候选需按新条件重新匹配，询价尚未保存。`);
  };
  const exportInquiries = async () => {
    if (disabled || !records.length) return; setExportBusy(true); setError("");
    try {
      const response = await fetch("/api/platform/inquiries-export.csv", { cache: "no-store" });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as {error?:{message?:string}}; throw new Error(body.error?.message || "询价导出未完成，请重试。"); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = `冠英询价跟进表_${new Date().toISOString().slice(0,10)}.csv`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      setNotice("询价表已导出，包含候选依据、待核条件与跟进安排。");
    } catch(cause) {setError(cause instanceof Error ? cause.message : "询价导出未完成。");}
    finally {setExportBusy(false);}
  };
  const confirmRelation = async (payload: Record<string, unknown>) => {
    pendingSave.current = { previousIds: records.map(item => item.id), id: selectedId, companyId, sourceText: sourceText.trim() };
    try { await onAction("confirm_fitment", { ...payload, companyId, inquiryId: selectedId, candidateId: confirmCandidate?.id, expectedRevision: revision }); setConfirmCandidate(null); }
    catch (cause) { pendingSave.current = null; throw cause; }
  };
  const saveQuoteReference: Props["onAction"] = async (type, payload) => {
    pendingQuoteRevision.current = selectedId || null;
    try { await onAction(type, payload); }
    catch(cause) { pendingQuoteRevision.current = null; throw cause; }
  };
  const saveAssuranceAction: Props["onAction"] = async (type, payload) => {
    pendingAssuranceRevision.current = selectedId || null;
    try { await onAction(type, payload); }
    catch (cause) { pendingAssuranceRevision.current = null; throw cause; }
  };
  const saveMaterialAction: Props["onAction"] = async (type, payload) => {
    if (!selectedId || dirty || stale || currentRecord?.revision !== revision) throw new Error("请先保存并核对当前询价，再留存材料核算。");
    pendingMaterialRevision.current = selectedId;
    try { await onAction(type, payload); }
    catch (cause) { pendingMaterialRevision.current = null; throw cause; }
  };
  const useCandidateForMaterial = (candidate: FitmentCandidate) => {
    setMaterialSourceRequest({ candidate, sequence: ++materialRequestSequence.current, contextKey: materialContextKey });
    requestAnimationFrame(() => document.getElementById("material-cost-calculator")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const field = (label: string, key: Exclude<keyof InquiryInputs, "dimensionUnitConfirmed">, placeholder = "", extra: { type?: string; step?: string; min?: string; max?: string; span?: boolean } = {}) => <label className={`ts-iq-field ${extra.span ? "ts-iq-span" : ""}`} key={key}><span>{label}</span><input value={inputs[key]} onChange={event => setInput(key, event.target.value)} placeholder={placeholder} type={extra.type || "text"} step={extra.step} min={extra.min} max={extra.max} maxLength={key === "photoUrl" ? 2048 : 160} /></label>;
  const currentQuestion = analysis?.questions?.[0];
  const candidateCount = analysis?.totalCandidates ?? analysis?.candidates?.length ?? 0;

  return <div className="ts-iq-workspace">
    <div className="ts-iq-toolbar"><label><ClipboardList size={18} /><select aria-label="打开已保存的询价" value={selectedId} onChange={event => switchRecord(event.target.value)} disabled={disabled}><option value="">新询价 · 尚未保存</option>{[...records].reverse().map(record => <option key={record.id} value={record.id}>{state.companies.find(company => company.id === record.companyId)?.name || "客户"} · {record.inputs.axleModel || record.inputs.partCode || "待补车桥"} · {formatDate(record.updatedAt, true)}</option>)}</select><ChevronDown size={16} /></label><div><span className={`ts-iq-save-state ${dirty ? "is-dirty" : ""}`}>{dirty ? "有未保存内容" : selectedId ? "已保存到云端" : `${records.length} 条询价记录`}</span><Button onClick={exportInquiries} disabled={disabled || !records.length} busy={exportBusy}><ArrowDownToLine size={16} />导出询价</Button><Button onClick={() => switchRecord("")} disabled={disabled}><Plus size={16} />新建询价</Button><Button variant="primary" onClick={save} disabled={disabled} busy={saving}><Save size={16} />保存询价</Button></div></div>
    <div className="ts-iq-steps"><div className="active"><ClipboardList size={19} /><span><strong>记录需求</strong><small>先确认实际车桥</small></span></div><div className={analysis && !stale ? "active" : ""}><Layers3 size={19} /><span><strong>核对候选</strong><small>型号、条件、来源一起看</small></span></div><div><CalendarClock size={19} /><span><strong>报价跟进</strong><small>补齐条件，再给依据</small></span></div></div>
    {error && <div className="ts-iq-message is-error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}
    {notice && <div className="ts-iq-message" role="status"><CheckCircle2 size={18} /><span>{notice}</span></div>}
    {dataClass === "synthetic" && <div className="ts-iq-example-label"><BookOpen size={16} /><span>原厂资料核验案例 · 不代表客户订单或冠英供货承诺</span><button onClick={() => switchRecord("")}>开始实际询价</button></div>}
    <div className="ts-iq-grid">
      <section className="ts-panel ts-iq-input-panel"><header className="ts-iq-section-head"><div><span className="ts-iq-kicker">REQUIREMENT</span><h2>先确定桥，再找片</h2><p>已换过车桥时，以当前实物和铭牌为准。</p></div><Truck size={25} /></header>
        <div className="ts-iq-fields">
          <label className="ts-iq-field"><span>车桥品牌</span><input value={inputs.axleBrand} onChange={event => setInput("axleBrand", event.target.value)} list="ts-iq-axle-brands" placeholder="如 BPW、SAF" /><datalist id="ts-iq-axle-brands"><option value="BPW" /><option value="SAF" /></datalist></label>
          {field("车桥完整型号", "axleModel", "按铭牌记录完整型号")}
          {field("车桥制造年份", "year", "与车辆年款分别核对", { type: "number", min: "1900", max: "2100" })}
          <label className="ts-iq-field"><span>需要哪类制动件</span><select value={inputs.partType} onChange={event => setInput("partType", event.target.value)}>{PART_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {field("车桥额定轴荷（t）", "loadTons", "不确定可留空", { type: "number", min: "0", step: "0.1" })}
          {field("车型 · 辅助信息", "vehicleModel", "车型不能单独确认适配")}
          {field("旧件照片或铭牌链接", "photoUrl", "粘贴已授权的图片链接", { type: "url", span: true })}
          <p className="ts-iq-field-note ts-iq-span"><ImageIcon size={15} />照片链接用于回看，当前不会自动识别图片或推断尺寸。{safeUrl(inputs.photoUrl) && <ExternalLink url={inputs.photoUrl}>查看照片</ExternalLink>}</p>
        </div>
        <details className="ts-iq-more" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}><summary><SlidersHorizontal size={16} /><span>补充制动器、编号与关键尺寸</span><ChevronDown size={16} /></summary><div className="ts-iq-fields">
          {field("制动器型号", "brakeSystem", "如 SN 4218")}
          <label className="ts-iq-field"><span>现有编号体系</span><select value={inputs.codeNamespace} onChange={event => setInput("codeNamespace", event.target.value)}>{NAMESPACES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          {field("现有件号", "partCode", "保留前导零和原始字符", { span: true })}
          {field("片宽（mm）", "widthMm", "按实测或核准图纸", { type: "number", min: "0", step: "0.01" })}
          {field("片厚（mm）", "thicknessMm", "勿把 STD / 1+ 直接换成 mm", { type: "number", min: "0", step: "0.01" })}
          {field("制动鼓直径（mm）", "drumDiameterMm", "有依据再填写", { type: "number", min: "0", step: "0.01", span: true })}
          {field("目录片宽原值", "rawWidth", "例如目录记录的 180")}
          {field("目录片厚原值", "rawThickness", "完整保留，如 17.5/10.5")}
          {field("规格标记原文", "sizeCode", "如 STD、1+、2+；不自动换算", { span: true })}
          <label className="ts-iq-authorized ts-iq-span"><input type="checkbox" checked={inputs.dimensionUnitConfirmed} onChange={event => { setInputs(current => ({ ...current, dimensionUnitConfirmed: event.target.checked })); setDirty(true); }} /><span>企业已确认：以上目录尺寸与本次实测使用相同的 mm 单位</span></label>
        </div></details>
        <footer className="ts-iq-match-footer"><Button variant="primary" onClick={match} disabled={disabled} busy={matchBusy}><Search size={17} />{analysis ? "按当前条件重新匹配" : "查询目录候选"}</Button><span>实际目录规则查询 · 不调用模型生成件号</span></footer>
      </section>
      <section className={`ts-panel ts-iq-result-panel ${stale ? "is-stale" : ""}`} aria-live="polite"><header className="ts-iq-section-head"><div><span className="ts-iq-kicker">MATCH & EVIDENCE</span><h2>{analysis ? stale ? "条件已变更" : `${candidateCount} 个候选待核对` : "每个候选，都有来处"}</h2><p>{analysis ? stale ? "旧结果仅供对照，重新匹配后再继续。" : `显示前 ${analysis.candidates?.length || 0} 项；有候选不等于已确认适配。` : "输入车桥信息，看到件号、条件与原始依据。"}</p></div><span className="ts-iq-engine-tag"><FileCheck2 size={15} />目录核验</span></header>
        {!analysis ? <div className="ts-iq-empty"><div className="ts-iq-part-mark"><Layers3 size={45} strokeWidth={1.2} /></div><h3>把模糊询问，变成可核对的条件</h3><p>先查实际车桥，再逐步补充制动器、尺寸与原件编号。</p><Button onClick={() => { if (dirty) setSwitchTarget("example"); else loadExample(); }} disabled={disabled}><BookOpen size={16} />使用 BPW 原厂资料案例</Button><small>案例只填入真实目录条件，结果由匹配接口返回。</small></div> : <>
          {stale && <div className="ts-iq-stale-note"><RefreshCw size={16} /><span>当前尺寸或配置与上次查询不同，旧候选和价格不能沿用。</span></div>}
          {!stale && currentQuestion && <div className="ts-iq-next-question"><div><span>下一步先问这一项</span><Button variant="quiet" onClick={copyQuestion} disabled={disabled}><Copy size={15} />复制补问</Button></div><p>{currentQuestion}</p>{(analysis.questions?.length || 0) > 1 && <details><summary>查看其余补问（{analysis.questions!.length - 1}）</summary>{analysis.questions!.slice(1).map((question, index) => <p key={index}>{question}</p>)}</details>}</div>}
          <div className="ts-iq-candidates">{analysis.candidates?.length ? analysis.candidates.map(candidate => <CandidateCard key={candidate.id} candidate={candidate} stale={stale} quote={analysis.quoteRanges?.find(range => range.candidateId === candidate.id || range.partNumber === candidate.partNumber)} onConfirm={() => setConfirmCandidate(candidate)} confirmationDisabled={disabled || dirty || !selectedId || stale} onMaterialCost={candidate.kind === "company" && candidate.partType === "brake_lining" ? () => useCandidateForMaterial(candidate) : undefined} materialCostDisabled={disabled || stale} />) : <div className="ts-iq-no-match"><Search size={25} /><strong>这组条件还没有找到可保留的候选</strong><p>{analysis.notice || analysis.message || "检查车桥型号、编号体系和原始尺寸，或补入企业已核准的对应关系。"}</p></div>}</div>
          {!!analysis.relatedCatalogue?.length && <details className="ts-iq-excluded ts-iq-related"><summary><span>冠英对应号待核 · {analysis.relatedCatalogue.length} 项目录线索</span><ChevronDown size={15} /></summary><p>以下仅有品牌或目录关联，尚未建立与该车桥的适配关系。</p>{analysis.relatedCatalogue.map(candidate => <CandidateCard key={candidate.id} candidate={candidate} stale={stale} onMaterialCost={candidate.kind === "company" && candidate.partType === "brake_lining" ? () => useCandidateForMaterial(candidate) : undefined} materialCostDisabled={disabled || stale} />)}</details>}
          {!!analysis.excluded?.length && <details className="ts-iq-excluded"><summary><span>已排除 {analysis.excluded.length} 项，查看原因</span><ChevronDown size={15} /></summary>{analysis.excluded.map((item, index) => <div key={item.id || index}><code>{item.partNumber || item.id || "目录候选"}</code><p>{item.reasons?.join("；") || item.reason || "与已提供条件冲突"}</p></div>)}</details>}
          {!!analysis.missing?.length && <details className="ts-iq-excluded"><summary><span>待补条件（{analysis.missing.length}）</span><ChevronDown size={15} /></summary><ul>{analysis.missing.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
          <footer className="ts-iq-result-footer"><span>{analysis.engineVersion || "条件匹配引擎"}</span>{lastMatchMs !== null && !stale ? <span>本次核验 {(lastMatchMs / 1000).toFixed(2)} 秒</span> : selectedId && <span>保存于 {formatDate(records.find(item => item.id === selectedId)?.updatedAt, true)}</span>}</footer>
        </>}
      </section>
    </div>
    <CustomerCareReply inputs={inputs} analysis={analysis} stale={stale} disabled={disabled} contextKey={`${companyId}:${selectedId}`} />
    <section className="ts-panel ts-iq-bottom-panel"><header className="ts-iq-section-head"><div><span className="ts-iq-kicker">INQUIRY & FOLLOW-UP</span><h2>接住这条询价，把下一步安排好</h2><p>已有信息先留存，缺少的条件带着问。</p></div><span className="ts-iq-record-count">{records.length} 条已保存</span></header>
      <div className="ts-iq-bottom-grid"><div><div className="ts-iq-fields">
        <label className="ts-iq-field"><span>关联客户</span><select value={companyId} disabled={!!selectedId} onChange={event => { setCompanyId(event.target.value); const company = state.companies.find(item => item.id === event.target.value); if (!owner && company?.owner) setOwner(company.owner); setDirty(true); }}><option value="">请选择客户</option>{state.companies.map(company => <option value={company.id} key={company.id}>{company.name}</option>)}</select>{selectedId && <small>已保存询价保留原客户；换客户请新建询价。</small>}</label>
        <label className="ts-iq-field"><span>询价渠道</span><select value={channel} onChange={event => { setChannel(event.target.value); setDirty(true); }}>{CHANNELS.map(value => <option key={value}>{value}</option>)}</select></label>
        {!state.companies.length && <p className="ts-iq-field-note ts-iq-span">当前还没有客户记录。<button className="ts-iq-text-button" onClick={onCreateCustomer}>先添加客户</button></p>}
        <label className="ts-iq-field ts-iq-span"><span>客户询价原文</span><textarea rows={4} value={sourceText} onChange={event => { setSourceText(event.target.value); setDirty(true); }} maxLength={12000} placeholder="粘贴客户原话，保留 STD / 1+ / 2+、数量及日期等原始信息。" /></label>
        <div className="ts-iq-extract-actions ts-iq-span"><Button onClick={extractSource} disabled={disabled || !state.capabilities.modelConfigured || !sourceText.trim()} busy={extractBusy}><FileSearch size={16} />AI 整理原文</Button><p>{state.capabilities.modelConfigured ? "真实调用 B1X，逐项确认后填表；计入账号今日模型调用记录，可在设置中查看。" : "配置 B1X 后可提取原文；当前可手工记录并查询目录。"}</p></div>
        <label className="ts-iq-field ts-iq-span"><span>询价或依据链接</span><input value={sourceUrl} onChange={event => { setSourceUrl(event.target.value); setDirty(true); }} type="url" maxLength={2048} placeholder="可留空；有来源时保留原链接" /></label>
        <label className="ts-iq-field"><span>负责人</span><input value={owner} onChange={event => { setOwner(event.target.value); setDirty(true); }} maxLength={100} placeholder="由谁继续核对" /></label>
        <label className="ts-iq-field"><span>下次跟进时间</span><input type="datetime-local" value={nextFollowUpAt} onChange={event => { setNextFollowUpAt(event.target.value); setDirty(true); }} /><small>留空则生成 2 小时后核对提醒，可修改。</small></label>
      </div></div><div className="ts-iq-commercial"><div className="ts-iq-commercial-head"><div><h3>报价条件</h3><p>可比的历史报价，才形成参考区间。</p></div><Button onClick={() => setQuoteOpen(true)} disabled={disabled || !companyId}><Plus size={15} />录入历史报价</Button></div><div className="ts-iq-fields">
        {field("材质 / 配方等级", "materialGrade", "以企业核准名称为准")}{field("采购数量", "quantity", "填写本次实际数量", { type: "number", min: "0", step: "1" })}
        {field("计价单位", "unit", "如：片 / 套 / 件")}{field("币种", "currency", "如 USD / CNY")}
        {field("贸易条款", "incoterm", "如 FOB / CIF / DDP")}{field("目的地 / 约定港口", "destination", "按原报价口径填写")}
        {field("附件及包装口径", "accessories", "例如是否包含铆钉及其材质", { span: true })}
      </div><div className="ts-iq-pricing-note"><FileText size={18} /><p>没有符合件号、材质、数量及交易条件的有效报价时，显示“待核价”。参考价仍需企业确认。</p></div></div></div>
      <footer className="ts-iq-save-footer"><div><CheckCircle2 size={18} /><span>保存原文、匹配依据和条件变化；有跟进日期时同步安排事项。</span></div><Button variant="primary" onClick={save} disabled={disabled} busy={saving}><Save size={16} />保存询价与跟进</Button></footer>
    </section>
    <MaterialCostCalculator key={materialContextKey} inquiry={currentRecord} currentInputs={inputs} companyId={companyId} revision={revision} needsSave={dirty || stale} disabled={disabled} busy={busy} candidates={[...(analysis?.candidates || []), ...(analysis?.relatedCatalogue || [])]} sourceRequest={materialSourceRequest?.contextKey === materialContextKey ? materialSourceRequest : null} resetNotice={materialResetNotice} onAction={saveMaterialAction} />
    <ServiceAssurance sourceText={sourceText} inquiry={records.find(item => item.id === selectedId)} records={state.commitmentRecords || []} needsSave={dirty || stale} busy={busy} onAction={saveAssuranceAction} />
    {!!history.length && <details className="ts-iq-history ts-panel"><summary><History size={18} /><span>条件与候选变化记录</span><b>{history.length}</b><ChevronDown size={16} /></summary><div>{history.slice(-6).reverse().map((item, index) => <HistoryItem key={asText(item.id) || index} item={item} />)}</div></details>}
    {quoteOpen && <QuoteReferenceForm onClose={() => setQuoteOpen(false)} onSave={saveQuoteReference} busy={busy === "add_quote_reference"} initial={inputs} companyId={companyId} inquiryId={selectedId} dataClass={dataClass} onSaved={() => { setQuoteOpen(false); setAnalysisBasis(""); setNotice("历史报价已保存。重新匹配，可按当前条件检查参考区间。"); }} />}
    {confirmCandidate && <ConfirmRelationForm candidate={confirmCandidate} onClose={() => setConfirmCandidate(null)} onSave={confirmRelation} busy={busy === "confirm_fitment"} />}
    {extraction && <Modal title="核对从原文提取的字段" description="勾选需要采用的值。与现值不同的字段会在确认后替换；原始询价仍保留。" onClose={() => setExtraction(null)} wide><div className="ts-iq-extract-review"><div className="ts-iq-extract-meta"><span>{extraction.model}</span><span>{extraction.fields.length} 个字段</span></div>{extraction.fields.length ? extraction.fields.map((item, index) => <label className="ts-iq-extract-row" key={`${item.field}-${index}`}><input type="checkbox" checked={extractedChecked.includes(item.field)} onChange={event => setExtractedChecked(current => event.target.checked ? [...current, item.field] : current.filter(key => key !== item.field))} /><div><strong>{FIELD_NAMES[item.field] || item.field}</strong><p>{inputs[item.field] && inputs[item.field] !== item.value ? <><del>{inputs[item.field]}</del><span>替换为</span></> : null}<b>{item.value}</b></p><blockquote>{item.quote}</blockquote></div></label>) : <p>原文中没有可直接采用的结构化字段。请补问客户，或手工核对资料。</p>}{!!extraction.unknowns?.length && <p className="ts-iq-field-note">仍未知：{extraction.unknowns.join("；")}</p>}<footer className="ts-modal-footer"><Button onClick={() => setExtraction(null)}>暂不应用</Button><Button variant="primary" onClick={applyExtracted} disabled={!extractedChecked.length}>应用已选字段（{extractedChecked.length}）</Button></footer></div></Modal>}
    {switchTarget !== null && <Modal title="先处理当前未保存的询价" description="切换后，这次尚未保存的输入会被替换。" onClose={() => setSwitchTarget(null)}><div className="ts-iq-switch-body"><p>可以先返回保存，或者放弃本次修改后继续。</p><div><Button onClick={() => setSwitchTarget(null)}>返回继续编辑</Button><Button variant="primary" onClick={() => { const target = switchTarget; setSwitchTarget(null); if (target === "example") loadExample(); else loadRecord(target); }}>放弃修改并继续</Button></div></div></Modal>}
  </div>;
}

function CandidateCard({ candidate, stale, quote, onConfirm, confirmationDisabled, onMaterialCost, materialCostDisabled }: { candidate: FitmentCandidate; stale: boolean; quote?: QuoteRange; onConfirm?: () => void; confirmationDisabled?: boolean; onMaterialCost?: () => void; materialCostDisabled?: boolean }) {
  const dimensions = Object.entries(candidate.dimensions || {}).filter(([key, value]) => key !== "unit" && value !== null && value !== "");
  const labels: Record<string, string> = { widthMm: "片宽", thicknessMm: "片厚", drumDiameterMm: "鼓径", width: "片宽", thickness: "片厚", outerArcMm: "A", innerArcMm: "B", lengthA: "A", lengthB: "B" };
  const hasPrice = !stale && typeof quote?.min === "number" && typeof quote?.max === "number";
  return <article className="ts-iq-candidate"><div className="ts-iq-candidate-top"><div><small>{candidate.kind === "oem" ? "原厂参考编号" : "冠英目录候选"} · {candidate.namespace}</small><h3>{candidate.partNumber}</h3></div><span className={`ts-iq-candidate-state ${candidate.status === "confirmed" ? "confirmed" : ""}`}>{stale ? "结果已过时" : candidate.status === "confirmed" ? "已核准关系" : "待核对适配"}</span></div><p className="ts-iq-candidate-name">{candidate.name || candidate.manufacturer}</p>
    {!!(candidate.codes?.length || candidate.aliases?.length) && <div className="ts-iq-codes">{(candidate.codes || candidate.aliases?.map(item => ({namespace:item.namespace,value:item.code})) || []).map((code, index) => <code key={index}>{code.namespace} {code.value}</code>)}</div>}
    {!!dimensions.length && <dl className="ts-iq-dimensions">{dimensions.map(([key, value]) => <div key={key}><dt>{labels[key] || key}</dt><dd>{String(value)}{candidate.dimensions?.unit === "mm" ? " mm" : "（目录原值）"}</dd></div>)}</dl>}
    {!!candidate.reasons?.length && <p className="ts-iq-reason"><Check size={15} />{candidate.reasons.join("；")}</p>}
    {candidate.note && <p className="ts-iq-candidate-note">{candidate.note}</p>}
    <details className="ts-iq-evidence"><summary><FileText size={15} /><span>查看原始依据 · {candidate.evidence?.length || 0} 项</span><ChevronDown size={14} /></summary>{candidate.evidence?.map((evidence, index) => <div key={index}><strong>{evidence.title || "来源资料"}{evidence.page !== undefined ? ` · ${evidence.page}` : ""}</strong>{evidence.quote && <blockquote>{evidence.quote}</blockquote>}{evidence.url && <ExternalLink url={evidence.url}>打开来源</ExternalLink>}</div>)}{!!candidate.missing?.length && <p>仍需核对：{candidate.missing.join("；")}</p>}</details>
    <div className="ts-iq-price"><span>参考价</span><strong>{hasPrice ? `${quote!.currency || ""} ${quote!.min!.toFixed(2)}–${quote!.max!.toFixed(2)} / ${quote!.unit || "单位待定"}` : stale ? "重新匹配后核价" : "待核价"}</strong><small>{hasPrice ? `${quote!.incoterm || ""} · ${quote!.label || quote!.note || "相同交易条件下的历史参考，仍需确认"}` : quote?.reason || "尚无满足当前交易条件的有效历史报价"}</small>{hasPrice && <small>{quote!.sourceTitle || "已保存报价依据"} · {quote!.referenceIds?.length || 1} 条可比记录{quote!.validUntil ? ` · 有效至 ${new Intl.DateTimeFormat("zh-CN", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(quote!.validUntil))}` : ""}{quote!.sourceUrl && <> · <ExternalLink url={quote!.sourceUrl}>报价来源</ExternalLink></>}</small>}</div>
    {onMaterialCost && <div className="mcc-candidate-action"><Button onClick={onMaterialCost} disabled={materialCostDisabled}><Calculator size={15} />采用目录尺寸试算</Button><small>按 mm 假设及双厚度核算，不确认适配</small></div>}
    {onConfirm && candidate.status !== "confirmed" && <div className="ts-iq-confirm-action"><Button variant="quiet" onClick={onConfirm} disabled={confirmationDisabled} title={confirmationDisabled ? "请先保存当前询价；条件有变化时需重新核验" : "登记技术人员已核准的限定关系"}><FileCheck2 size={15} />登记技术核准</Button><small>仅对这条询价的当前配置有效</small></div>}
  </article>;
}

function HistoryItem({ item }: { item: Record<string, unknown> }) {
  const changes = item.changes as Array<Record<string, unknown>> | undefined;
  const initial = !item.beforeFingerprint;
  const changedFields = Array.isArray(item.changedFields) ? item.changedFields.map(key => FIELD_NAMES[String(key)] || String(key)) : [];
  const partLabel = (value: unknown) => String(value).replace(/^bpw-/i, "");
  return <article><time>{formatDate(asText(item.createdAt || item.at || item.updatedAt), true)}</time><div><strong>{initial ? "首次保存询价条件" : asText(item.summary || item.reason || item.title) || "询价条件与候选已重新核对"}</strong>{!initial && changedFields.length > 0 && <p>重新核对：{changedFields.join("、")}</p>}{item.quoteInvalidated === true && <p>规格发生变化，原参考报价已重新核验。</p>}{!initial && changes?.map((change, index) => <p key={index}>{FIELD_NAMES[asText(change.field)] || asText(change.field)}：{asText(change.before) || "未提供"} → {asText(change.after) || "待确认"}</p>)}{!initial && Array.isArray(item.removed) && item.removed.length > 0 && <p>移除候选：{item.removed.map(partLabel).join("、")}</p>}{Array.isArray(item.added) && item.added.length > 0 && <p>{initial ? "记录候选" : "新增候选"}：{item.added.map(partLabel).join("、")}</p>}</div></article>;
}

function ConfirmRelationForm({ candidate, onClose, onSave, busy }: { candidate: FitmentCandidate; onClose: () => void; onSave: (payload: Record<string, unknown>) => Promise<void>; busy: boolean }) {
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return; setError("");
    const data = new FormData(event.currentTarget); const pick = (key: string) => String(data.get(key) || "").trim();
    try { await onSave({ sourceTitle: pick("sourceTitle"), sourceText: pick("sourceText"), sourceUrl: pick("sourceUrl"), confirmedBy: pick("confirmedBy"), authorized: true }); }
    catch(cause) { setError(cause instanceof Error ? cause.message : "未能保存核准关系，请核对依据。"); }
  };
  return <Modal title="登记技术人员的核准结论" description={`当前候选：${candidate.namespace} ${candidate.partNumber}。核准仅适用于已保存的这条询价和配置。`} onClose={onClose}><form className="ts-form ts-iq-quote-form" onSubmit={submit}><div className="ts-form-grid">
    <label className="ts-field ts-span-2">核准依据名称 *<input name="sourceTitle" required maxLength={200} placeholder="经核准图纸、适配表、检测记录或技术确认" /></label>
    <label className="ts-field ts-span-2">核准内容与适用条件 *<textarea name="sourceText" rows={4} required maxLength={5000} placeholder="明确写出车桥、制动器、具体件号、尺寸、版本及适用范围" /></label>
    <label className="ts-field">技术核准人 *<input name="confirmedBy" required maxLength={100} /></label><label className="ts-field">原始依据链接<input name="sourceUrl" type="url" maxLength={2048} /></label>
    {candidate.kind === "oem" && <p className="ts-iq-field-note ts-span-2">当前是原厂参考编号；登记此关系不会自动认定冠英的替代产品适配。</p>}
    <label className="ts-iq-authorized ts-span-2"><input type="checkbox" required /><span>我确认已获得企业技术人员核准，原始依据与当前配置一致。</span></label>
  </div>{error && <p className="ts-inline-error" role="alert">{error}</p>}<footer className="ts-modal-footer"><Button type="button" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" variant="primary" busy={busy}>保存限定关系</Button></footer></form></Modal>;
}

function QuoteReferenceForm({ onClose, onSave, busy, initial, onSaved, companyId, inquiryId, dataClass }: { onClose: () => void; onSave: Props["onAction"]; busy: boolean; initial: InquiryInputs; onSaved: () => void; companyId: string; inquiryId: string; dataClass: "real" | "synthetic" }) {
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return; setError("");
    const form = new FormData(event.currentTarget); const text = (key: string) => String(form.get(key) || "").trim();
    const payload: Record<string, unknown> = Object.fromEntries(["partNumber", "namespace", "materialGrade", "currency", "unit", "incoterm", "destination", "accessories", "sourceTitle", "sourceText", "sourceUrl"].map(key => [key, text(key)]));
    for (const key of ["unitPrice", "quantityMin", "quantityMax"]) payload[key] = Number(text(key));
    const validFrom = text("validFrom"), validUntil = text("validUntil");
    payload.validFrom = validFrom ? new Date(validFrom + "T00:00:00+08:00").toISOString() : "";
    payload.validUntil = validUntil ? new Date(validUntil + "T23:59:59+08:00").toISOString() : "";
    Object.assign(payload, { companyId, ...(inquiryId ? { inquiryId } : {}), dataClass, inputs: initial, authorized: true });
    try { await onSave("add_quote_reference", payload); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "报价资料尚未保存，内容已保留。"); }
  };
  return <Modal title="录入有依据的历史报价" description="每次录入一条原始单价，系统只汇总相同规格和交易条件下的有效报价。" onClose={onClose} wide><form className="ts-form ts-iq-quote-form" onSubmit={submit}><div className="ts-form-grid">
    {dataClass === "synthetic" && <p className="ts-iq-field-note ts-span-2">此记录属于资料练习，将与真实询价的报价隔离。</p>}
    <label className="ts-field">具体件号 *<input name="partNumber" required defaultValue={initial.partCode} /></label><label className="ts-field">编号体系 *<select name="namespace" defaultValue={initial.codeNamespace === "unknown" ? "" : initial.codeNamespace} required><option value="">请选择</option>{NAMESPACES.filter(([value]) => value !== "unknown").map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    <label className="ts-field">材质 / 配方等级 *<input name="materialGrade" required defaultValue={initial.materialGrade} /></label><label className="ts-field">计价单位 *<input name="unit" required defaultValue={initial.unit} placeholder="片 / 套 / 件" /></label>
    <label className="ts-field">适用最低数量 *<input name="quantityMin" required type="number" min="1" step="1" defaultValue={initial.quantity} /></label><label className="ts-field">适用最高数量 *<input name="quantityMax" required type="number" min="1" step="1" defaultValue={initial.quantity} /></label>
    <label className="ts-field">原报价单价 *<input name="unitPrice" type="number" required min="0.0001" step="any" /></label><label className="ts-field">币种 *<input name="currency" required defaultValue={initial.currency} placeholder="USD / CNY" /></label>
    <p className="ts-iq-field-note ts-span-2">报价有效日期按北京时间（UTC+8）保存。</p><label className="ts-field">有效起始日期 *<input name="validFrom" type="date" required /></label><label className="ts-field">有效截止日期 *<input name="validUntil" type="date" required /></label>
    <label className="ts-field">贸易条款 *<input name="incoterm" required defaultValue={initial.incoterm} placeholder="FOB / CIF / DDP" /></label><label className="ts-field">目的地 / 约定港口 *<input name="destination" required defaultValue={initial.destination} /></label>
    <label className="ts-field ts-span-2">附件及包装口径 *<input name="accessories" required defaultValue={initial.accessories} placeholder="无附件也请明确填写" /></label>
    <label className="ts-field ts-span-2">原报价单名称 / 编号 *<input name="sourceTitle" required maxLength={200} /></label>
    <label className="ts-field ts-span-2">原始依据与核准说明 *<textarea name="sourceText" required rows={3} maxLength={5000} placeholder="报价日期、核准人、适用规格、原文或核价依据" /></label>
    <label className="ts-field ts-span-2">来源链接<input name="sourceUrl" type="url" maxLength={2048} /></label>
    <label className="ts-iq-authorized ts-span-2"><input type="checkbox" required /><span>{dataClass === "real" ? "我确认这是企业授权、可以用于当前客户参考的真实报价。" : "我确认这是核验练习资料，不能当作真实业务报价。"}</span></label>
  </div>{error && <p className="ts-inline-error" role="alert">{error}</p>}<footer className="ts-modal-footer"><Button type="button" onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" type="submit" busy={busy}>保存报价依据</Button></footer></form></Modal>;
}
