"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Calculator, CheckCircle2, ChevronDown, FileText, History, Layers3, RotateCcw, Save } from "lucide-react";
import { buildMaterialCostDraft, calculateMaterialCost, convertDensity, convertLength, convertMaterialPrice, MATERIAL_FORMULA } from "@/lib/platform/material-cost.mjs";
import { Button, ExternalLink } from "./PlatformUI";
import { formatDate } from "./types";
import type { FitmentCandidate, InquiryInputs, InquiryRecord, MaterialCalculationRecord, MaterialCostCalculation, MaterialCostInputs, MaterialDensityUnit, MaterialLengthUnit, MaterialMeasure, MaterialPriceUnit } from "./inquiry-types";
import "./MaterialCostCalculator.css";

export type MaterialSourceRequest = { candidate: FitmentCandidate; sequence: number };
type Props = { inquiry?: InquiryRecord; currentInputs: InquiryInputs; companyId: string; revision?: number; needsSave: boolean; disabled: boolean; busy: string; candidates: FitmentCandidate[]; sourceRequest: MaterialSourceRequest | null; resetNotice?: string; onAction: (type: string, payload: Record<string, unknown>) => Promise<void> };
type LengthField = "outerArc" | "width" | "thickness1" | "thickness2";
const LENGTH_UNITS = [{ value:"mm",label:"mm" },{ value:"cm",label:"cm" },{ value:"m",label:"m" },{ value:"in",label:"英寸 in" }];
const DENSITY_UNITS = [{ value:"g/cm3",label:"g/cm³" },{ value:"kg/m3",label:"kg/m³" }];
const PRICE_UNITS = [{ value:"kg",label:"每 kg" },{ value:"g",label:"每 g" },{ value:"tonne",label:"每公吨 t" },{ value:"lb",label:"每磅 lb" }];
const displayNumber = (value: number, digits = 6) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
const money = (value: number, maximumFractionDigits = 6) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits }).format(value);
const compactNumber = (value: number) => String(Number(value.toPrecision(12)));
function displayed<Unit extends string>(field: MaterialMeasure<Unit>, convert: (value: string, from: Unit, to: Unit) => number) {
  const displayUnit = field.displayUnit || field.unit;
  if (!field.value.trim() || displayUnit === field.unit) return field.value;
  try { return compactNumber(convert(field.value, field.unit, displayUnit)); } catch { return field.value; }
}

export default function MaterialCostCalculator({ inquiry, currentInputs, companyId, revision, needsSave, disabled, busy, candidates, sourceRequest, resetNotice, onAction }: Props) {
  const [draft, setDraft] = useState<MaterialCostInputs>(() => buildMaterialCostDraft(inquiry || { inputs: currentInputs }, undefined) as MaterialCostInputs);
  const [sourceCandidateId, setSourceCandidateId] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [sourceEdited, setSourceEdited] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(resetNotice || "");
  const [savedSignature, setSavedSignature] = useState("");
  const saveRequest = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => { if (resetNotice) setNotice(resetNotice); }, [resetNotice]);
  const eligible = candidates.filter(candidate => candidate.kind === "company" && candidate.partType === "brake_lining");
  const source = eligible.find(candidate => candidate.id === sourceCandidateId);
  const sourceMissing = !!sourceCandidateId && !source;
  const history = inquiry?.materialCalculations || [];
  const calculation = useMemo(() => {
    try { return { value: calculateMaterialCost(draft) as unknown as MaterialCostCalculation, message: "" }; }
    catch (cause) { return { value: null, message: cause instanceof Error ? cause.message : "请补齐核算条件。" }; }
  }, [draft]);
  const signature = JSON.stringify({ inquiryId: inquiry?.id || "", companyId, inputs: draft, sourceCandidateId, basis: inquiry?.inputs, sourceText: inquiry?.sourceText, sourceUrl: inquiry?.sourceUrl });
  const versionMatches = !!inquiry && inquiry.companyId === companyId && inquiry.revision === revision;
  const canSave = !!calculation.value && versionMatches && !needsSave && !disabled && !sourceMissing && savedSignature !== signature;
  const priceDisplayPer = draft.materialPrice.displayPer || draft.materialPrice.per;
  const priceDisplay = displayed({ value: draft.materialPrice.value, unit: draft.materialPrice.per, displayUnit: draft.materialPrice.displayPer }, convertMaterialPrice);
  const clearFeedback = () => { setError(""); setNotice(""); };
  const adoptCandidate = (candidate: FitmentCandidate) => {
    if (candidate.kind !== "company" || candidate.partType !== "brake_lining") return;
    const values = buildMaterialCostDraft(inquiry || { inputs: currentInputs }, candidate) as MaterialCostInputs;
    setDraft(current => ({ ...current, outerArc: values.outerArc, width: values.width, thickness1: values.thickness1, thickness2: values.thickness2 }));
    setSourceCandidateId(candidate.id); setSelectedCandidateId(candidate.id); setSourceEdited(false); setError("");
    setNotice("已采用目录原值作材料试算：尺寸按 mm 假设，斜杠值按两端厚度；没有确认适配。");
  };
  useEffect(() => {
    if (sourceRequest) adoptCandidate(sourceRequest.candidate);
    // Only an explicit catalogue button applies a source; ordinary parent edits do not overwrite this draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceRequest?.sequence]);
  const updateLength = (field: LengthField, value: string) => {
    setDraft(current => ({ ...current, [field]: { ...current[field], value, unit: current[field].displayUnit || current[field].unit } }));
    setSourceEdited(true); clearFeedback();
  };
  const changeLengthUnit = (field: LengthField, displayUnit: MaterialLengthUnit) => {
    setDraft(current => ({ ...current, [field]: { ...current[field], displayUnit } })); clearFeedback();
  };
  const updateOrder = (patch: Partial<MaterialCostInputs["order"]>) => { setDraft(current => ({ ...current, order: { ...current.order, ...patch } })); clearFeedback(); };
  const save = async () => {
    if (!canSave || !inquiry || !calculation.value) return;
    setError(""); setNotice("");
    if (!saveRequest.current || saveRequest.current.signature !== signature) saveRequest.current = { signature, id: crypto.randomUUID() };
    try {
      await onAction("save_material_calculation", { companyId, inquiryId: inquiry.id, expectedRevision: revision, clientRequestId: saveRequest.current.id, sourceCandidateId, inputs: draft });
      setSavedSignature(signature); setNotice("核算依据已保存。服务端已按原始数值和单位重算，目录来源与公式一并留存。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "核算尚未保存，输入仍保留。"); }
  };
  const restore = (record: MaterialCalculationRecord) => {
    setDraft(structuredClone(record.inputs)); setSourceCandidateId(record.sourceCandidateId || ""); setSelectedCandidateId(record.sourceCandidateId || ""); setSourceEdited(true); setError(""); saveRequest.current = null;
    setNotice(record.stale ? "已恢复历史输入供重新核对。该记录对应的询价条件已变化；保存时会按当前已保存询价重新核验。" : "已恢复历史输入，可修改后重新核算；原历史记录保留。");
  };
  const lengthInput = (field: LengthField, label: string) => <label className="mcc-field"><span>{label}</span><div className="mcc-measure"><input value={displayed(draft[field], convertLength)} onChange={event => updateLength(field, event.target.value)} inputMode="decimal" maxLength={80} placeholder="填写正数" disabled={disabled} aria-label={label} /><select value={draft[field].displayUnit || draft[field].unit} onChange={event => changeLengthUnit(field, event.target.value as MaterialLengthUnit)} disabled={disabled} aria-label={`${label}显示单位`}>{LENGTH_UNITS.map(unit => <option value={unit.value} key={unit.value}>{unit.label}</option>)}</select></div></label>;

  return <section className="ts-panel mcc-panel" id="material-cost-calculator"><header className="mcc-heading"><div><span className="mcc-kicker">MATERIAL COST</span><h2>把材料成本，当场算清楚</h2><p>输入完整即刻计算；材料参考单独留存，完整销售报价继续核准。</p></div><span className="mcc-rule-tag"><Calculator size={16} />公式核算</span></header>
    {error && <div className="mcc-feedback is-error" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
    {notice && <div className="mcc-feedback" role="status"><CheckCircle2 size={17} /><span>{notice}</span></div>}
    {eligible.length > 0 && <div className="mcc-catalog-picker"><div><Layers3 size={18} /><label><span>可选：采用冠英目录尺寸</span><select value={selectedCandidateId} onChange={event => setSelectedCandidateId(event.target.value)} disabled={disabled}><option value="">选择当前候选或旁证目录行</option>{eligible.map(candidate => <option value={candidate.id} key={candidate.id}>{candidate.partNumber} · {candidate.name || "鼓式衬片"}</option>)}</select></label></div><Button onClick={() => { const selected = eligible.find(candidate => candidate.id === selectedCandidateId); if (selected) adoptCandidate(selected); }} disabled={disabled || !selectedCandidateId}><Layers3 size={15} />采用尺寸试算</Button></div>}
    {sourceCandidateId && <div className="mcc-source-note"><FileText size={16} /><div><strong>{source ? `${source.partNumber} · 目录原值参考${sourceEdited ? "，当前以核算输入为准" : ""}` : "历史目录来源不在当前候选中"}</strong><p>{sourceMissing ? "重新选择当前目录行，或明确改用手工核算后再保存。" : "目录未明示的尺寸单位按 mm 假设；双厚度按两端值试算，不代表适配核准。"}</p>{source && <details><summary>查看目录原值与来源</summary><p>外弧 A：{String(source.dimensionsRaw?.A_outer_arch || "未提供")} · 宽度 C：{String(source.dimensionsRaw?.C_width || "未提供")} · 厚度 D：{String(source.dimensionsRaw?.D_thickness || "未提供")}</p>{source.evidence?.map((evidence,index) => <p key={index}>{evidence.title}{evidence.page ? ` · ${evidence.page}` : ""}{evidence.url && <> · <ExternalLink url={evidence.url}>原始来源</ExternalLink></>}</p>)}</details>}</div><Button variant="quiet" onClick={() => { setSourceCandidateId(""); setSelectedCandidateId(""); setSourceEdited(false); clearFeedback(); }} disabled={disabled}>改用手工核算</Button></div>}
    <div className="mcc-layout"><div className="mcc-inputs"><h3>尺寸与材料条件</h3><div className="mcc-field-grid">
      {lengthInput("outerArc", "外弧长度")}{lengthInput("width", "片宽")}{lengthInput("thickness1", "厚度 1")}{lengthInput("thickness2", "厚度 2")}
      <label className="mcc-field"><span>材料密度</span><div className="mcc-measure"><input value={displayed(draft.density, convertDensity)} onChange={event => { setDraft(current => ({ ...current, density: { ...current.density, value: event.target.value, unit: current.density.displayUnit || current.density.unit } })); clearFeedback(); }} inputMode="decimal" maxLength={80} disabled={disabled} /><select value={draft.density.displayUnit || draft.density.unit} onChange={event => { setDraft(current => ({ ...current, density: { ...current.density, displayUnit: event.target.value as MaterialDensityUnit } })); clearFeedback(); }} disabled={disabled} aria-label="密度显示单位">{DENSITY_UNITS.map(unit => <option key={unit.value} value={unit.value}>{unit.label}</option>)}</select></div><small>起始假设 2.2 g/cm³，可按核准材料修改。</small></label>
      <label className="mcc-field"><span>核算系数</span><input value={draft.adjustmentFactor} onChange={event => { setDraft(current => ({ ...current, adjustmentFactor: event.target.value })); clearFeedback(); }} inputMode="decimal" maxLength={80} disabled={disabled} /><small>起始假设 1.15，不作为已核准损耗率。</small></label>
      <label className="mcc-field"><span>材料单价</span><div className="mcc-measure"><input value={priceDisplay} onChange={event => { setDraft(current => ({ ...current, materialPrice: { ...current.materialPrice, value: event.target.value, per: current.materialPrice.displayPer || current.materialPrice.per } })); clearFeedback(); }} inputMode="decimal" maxLength={80} placeholder="填写材料价" disabled={disabled} /><select value={priceDisplayPer} onChange={event => { setDraft(current => ({ ...current, materialPrice: { ...current.materialPrice, displayPer: event.target.value as MaterialPriceUnit } })); clearFeedback(); }} disabled={disabled} aria-label="材料价格显示单位">{PRICE_UNITS.map(unit => <option key={unit.value} value={unit.value}>{unit.label}</option>)}</select></div></label>
      <label className="mcc-field"><span>材料价格原币种</span><input value={draft.materialPrice.currency} onChange={event => { setDraft(current => ({ ...current, materialPrice: { ...current.materialPrice, currency: event.target.value.toUpperCase() } })); clearFeedback(); }} maxLength={3} placeholder="如 CNY / USD" autoCapitalize="characters" disabled={disabled} /><small>保持材料价原币种，不自动换汇。</small></label>
    </div><p className="mcc-unit-note">单位切换只改变显示；计算始终使用原始数值。STD / 1+ / 2+ 不作为尺寸。</p>
    <div className="mcc-order"><h3>数量口径</h3><div className="mcc-field-grid"><label className="mcc-field"><span>采购数量 <em>可选</em></span><input value={draft.order.quantity} onChange={event => updateOrder({ quantity: event.target.value })} inputMode="numeric" maxLength={80} placeholder="留空只核算单片" disabled={disabled} /></label><label className="mcc-field"><span>数量单位</span><select value={draft.order.unit} onChange={event => updateOrder({ unit: event.target.value as "piece" | "set", piecesPerSet: "" })} disabled={disabled}><option value="piece">片</option><option value="set">套</option></select></label>{draft.order.unit === "set" && <label className="mcc-field mcc-span"><span>每套同规格衬片数量</span><input value={draft.order.piecesPerSet} onChange={event => updateOrder({ piecesPerSet: event.target.value })} inputMode="numeric" maxLength={80} placeholder="未知留空，不默认 1 片" disabled={disabled} /><small>只有同规格片数明确后才汇总；不同规格或附件另算。</small></label>}</div></div>
    <details className="mcc-input-notes"><summary><FileText size={15} />材料价来源与核算备注<ChevronDown size={14} /></summary><label className="mcc-field"><span>材料价格原文 / 来源</span><textarea rows={2} value={draft.materialPrice.sourceText} onChange={event => { setDraft(current => ({ ...current, materialPrice: { ...current.materialPrice, sourceText: event.target.value } })); clearFeedback(); }} maxLength={2000} placeholder="如供应商报价日期、材料等级、含税口径" disabled={disabled} /></label><label className="mcc-field"><span>核算备注</span><textarea rows={2} value={draft.note} onChange={event => { setDraft(current => ({ ...current, note: event.target.value })); clearFeedback(); }} maxLength={2000} disabled={disabled} /></label></details>
    </div><aside className="mcc-result" aria-live="polite"><span className="mcc-result-label">单片材料核算参考</span>{calculation.value ? <><div className="mcc-result-amount"><small>{calculation.value.result.currency}</small><strong>{money(calculation.value.result.materialPerPiece)}</strong><span>/ 片</span></div><p className="mcc-result-disclaimer">材料参考，不是完整销售报价</p><dl className="mcc-result-facts"><div><dt>公式体积</dt><dd>{displayNumber(calculation.value.result.volumeMm3)} mm³</dd></div><div><dt>理论材料重量</dt><dd>{displayNumber(calculation.value.result.theoreticalMassKg)} kg / 片</dd></div><div><dt>系数调整后重量</dt><dd>{displayNumber(calculation.value.result.adjustedMassKg)} kg / 片</dd></div><div><dt>统一材料单价</dt><dd>{calculation.value.result.currency} {displayNumber(calculation.value.normalized.materialPricePerKg)} / kg</dd></div></dl><div className="mcc-total"><span>{calculation.value.result.pieceQuantity == null ? "总额待数量口径确认" : `${displayNumber(calculation.value.result.pieceQuantity,0)} 片的材料核算总额`}</span><strong>{calculation.value.result.materialTotal == null ? "—" : `${calculation.value.result.currency} ${money(calculation.value.result.materialTotal,2)}`}</strong><small>{calculation.value.result.pieceQuantity == null ? draft.order.unit === "set" ? "请补采购数量及每套同规格片数。" : "补充采购数量后自动汇总。" : "按未舍入的单片结果汇总。"}</small></div>
      {inquiry?.inputs.currency && inquiry.inputs.currency !== calculation.value.result.currency && <p className="mcc-currency-note">询价币种为 {inquiry.inputs.currency}，本次按 {calculation.value.result.currency} 材料原价核算；未换汇。</p>}
      <details className="mcc-process"><summary><Calculator size={15} />展开计算过程<ChevronDown size={14} /></summary><p className="mcc-formula">{MATERIAL_FORMULA}</p><ol>{calculation.value.steps.map(step => <li key={step.key}><strong>{step.label}</strong><code>{step.expression}</code><span>{step.value == null ? "待确认" : String(step.value)} {step.value == null ? "" : step.unit}</span></li>)}</ol><p>原值留存：外弧 {draft.outerArc.value} {draft.outerArc.unit} · 片宽 {draft.width.value} {draft.width.unit} · 厚度 {draft.thickness1.value} {draft.thickness1.unit} / {draft.thickness2.value} {draft.thickness2.unit}；材料价 {draft.materialPrice.value} {draft.materialPrice.currency} / {draft.materialPrice.per}。</p></details>
      <details className="mcc-boundaries"><summary>查看假设与另核项目<ChevronDown size={14} /></summary><ul>{calculation.value.warnings.map((warning,index) => <li key={index}>{warning}</li>)}</ul></details></> : <div className="mcc-result-empty"><Calculator size={34} strokeWidth={1.4} /><strong>补齐条件，即时出结果</strong><p>{calculation.message}</p><small>需要外弧、片宽、两端厚度、密度、系数及材料原价。</small></div>}
    </aside></div>
    <footer className="mcc-footer"><div><CheckCircle2 size={17} /><span>{!inquiry ? "先保存这条询价，再留存核算依据。" : needsSave ? "询价有未保存或过时的条件，先保存并核对当前版本。" : !versionMatches ? "询价版本已更新，请重新打开并核对。" : sourceMissing ? "请先处理已变化的目录来源。" : savedSignature === signature ? "这组核算输入已保存。" : "保存原始输入、单位、公式与来源；服务端重新核算。"}</span></div><Button variant="primary" onClick={save} disabled={!canSave} busy={busy === "save_material_calculation"}><Save size={16} />保存核算依据</Button></footer>
    {history.length > 0 && <details className="mcc-history"><summary><History size={17} /><strong>材料核算历史</strong><span>{history.length} 条</span><ChevronDown size={15} /></summary><div className="mcc-history-list">{history.slice(-6).reverse().map(record => <article key={record.id}><div><div className="mcc-history-title"><strong>{record.result.currency} {money(record.result.materialPerPiece)} / 片</strong><span className={record.stale ? "is-stale" : ""}>{record.stale ? "询价条件已变化" : "对应已保存条件"}</span></div><p>{formatDate(record.createdAt,true)} · {record.sourceSnapshot.catalogue?.partNumber || "手工核算"}{record.dataClass === "synthetic" ? " · 样例资料" : ""}</p><p>原核算数量：{record.inputs.order.quantity || "未填"} {record.inputs.order.unit === "set" ? "套" : "片"}{record.inputs.order.unit === "set" ? ` · 每套 ${record.inputs.order.piecesPerSet || "未填"} 片` : ""} · 总额 {record.result.materialTotal == null ? "待确认" : `${record.result.currency} ${money(record.result.materialTotal,2)}`}</p><details><summary>核算来源快照</summary><p>{record.sourceSnapshot.formula}</p><p>外弧 {record.inputs.outerArc.value} {record.inputs.outerArc.unit} · 宽 {record.inputs.width.value} {record.inputs.width.unit} · 厚 {record.inputs.thickness1.value} {record.inputs.thickness1.unit} / {record.inputs.thickness2.value} {record.inputs.thickness2.unit}；密度 {record.inputs.density.value} {record.inputs.density.unit}，系数 {record.inputs.adjustmentFactor}。</p><p>材料价：{record.inputs.materialPrice.value} {record.result.currency} / {record.inputs.materialPrice.per} · {record.sourceSnapshot.materialPriceSourceText || "未填写价格来源"}</p>{record.assumptions.map((assumption,index) => <p key={index}>{assumption}</p>)}</details></div><Button onClick={() => restore(record)} disabled={disabled}><RotateCcw size={15} />恢复输入重算</Button></article>)}</div>{history.length > 6 && <p className="mcc-history-limit">这里显示最近 6 条，完整核算记录仍随询价保留。</p>}</details>}
  </section>;
}
