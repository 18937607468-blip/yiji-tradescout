"use client";

import { useRef, useState } from "react";
import { ArrowUpRight, Copy, Download, FileSpreadsheet, Globe2, ShieldCheck } from "lucide-react";
import { Button, ExternalLink, Modal } from "./PlatformUI";
import { COMPANY_HS_CATALOG, CUSTOMS_PLATFORM_URL, CUSTOMS_QA_SOURCE_URL } from "@/lib/platform/customs-catalog.mjs";

const SOURCE_URL = CUSTOMS_QA_SOURCE_URL;
const PLATFORM_URL = CUSTOMS_PLATFORM_URL;
const PRODUCT_DISPLAY: Record<string, { id: string; name: string; keywords: string; priority: string }> = {
  brake_lining: { id: "lining", name: "鼓式制动衬片 · Brake lining", keywords: "brake lining; brake linings", priority: "企业 Q&A 提供：鼓式产品占比 85%，优先研究。" },
  disc_brake_pad: { id: "pad", name: "盘式制动片 · Brake pad", keywords: "brake pad; brake pads", priority: "企业 Q&A 提供的盘式产品检索方向。" },
  brake_shoe: { id: "shoe", name: "蹄铁总成 · Brake shoes", keywords: "brake shoe; brake shoes", priority: "企业 Q&A 提供的蹄铁总成检索方向。" },
  clutch_facing: { id: "clutch", name: "离合器面片 · Clutch facing", keywords: "clutch facing; clutch facings", priority: "企业 Q&A 提供的离合器面片检索方向。" },
};
const PRODUCTS = COMPANY_HS_CATALOG.flatMap(item => PRODUCT_DISPLAY[item.category] ? [{ ...PRODUCT_DISPLAY[item.category], hs: item.companyCode }] : []);
const REGIONS = [
  { id: "southeast_asia", name: "东南亚", context: "企业 Q&A 提及的主要市场地区" },
  { id: "africa", name: "非洲", context: "企业 Q&A 提及的主要市场地区" },
  { id: "middle_east", name: "中东", context: "企业 Q&A 提及的主要市场地区" },
  { id: "south_america", name: "南美", context: "企业 Q&A 提及的主要市场地区" },
  { id: "north_america", name: "北美", context: "拟拓展地区，非已确认历史客户分布" },
  { id: "europe", name: "欧洲", context: "拟拓展地区，非已确认历史客户分布" },
];

export type CustomsDraft = { productId: string; regionId: string; country: string; hsLevel: "original" | "six"; keywords: string; wva: string };
export const DEFAULT_CUSTOMS_DRAFT: CustomsDraft = { productId: "lining", regionId: "southeast_asia", country: "", hsLevel: "six", keywords: PRODUCTS[0].keywords, wva: "" };

export default function CustomsProspecting({ draft, onChange, onClose, onImportCandidates }: {
  draft: CustomsDraft; onChange: (value: CustomsDraft) => void; onClose: () => void; onImportCandidates: () => void;
}) {
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const previewRef = useRef<HTMLTextAreaElement>(null);
  const product = PRODUCTS.find(item => item.id === draft.productId) || PRODUCTS[0];
  const region = REGIONS.find(item => item.id === draft.regionId) || REGIONS[0];
  const hsQuery = draft.hsLevel === "six" ? product.hs.slice(0, 6) : product.hs;
  const keywords = draft.keywords.split(/[;；,，\n]+/).map(value => value.trim()).filter(Boolean);
  const end = new Date();
  const start = new Date(end); start.setUTCFullYear(start.getUTCFullYear() - 1);
  const dates = { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
  const country = draft.country.trim();
  const task = {
    taskType: "manual_customs_prospecting", version: 1,
    productCategory: product.name,
    hs: { companyProvidedCode: product.hs, queryCode: hsQuery, granularity: draft.hsLevel === "six" ? "HS6" : "company_provided_code", skuConfirmed: false },
    target: { region: region.name, country: country || null, context: region.context },
    descriptionKeywords: keywords,
    keywordUsage: "建议词，可择一或组合；不要求货描同时包含全部词或型号",
    suggestedDateRange: { ...dates, label: "最近12个月建议，实际可用范围在授权平台确认" },
    optionalProductReview: { wva: draft.wva || null, mandatoryDescriptionFilter: false },
    verifyBeforeQualification: ["商用车业务相关性", "具体产品与适配", "进口或采购角色及来源", "近期需求需另行确认"],
    source: { title: "冠英官方 Q&A", url: SOURCE_URL },
    platformUrl: PLATFORM_URL,
    candidateCsvFields: ["name", "website", "market", "productRefs", "buyerRole", "owner", "notes", "sourceUrl"],
    execution: "仅生成人工检索条件，未调用海关 API，未获得查询结果",
  };
  const queryText = [
    `品类：${product.name}`,
    `企业提供 HS 原码：${product.hs}`,
    `本次 HS 查询条件：${hsQuery}（${draft.hsLevel === "six" ? "前6位粗筛" : "企业原码"}）`,
    `目标地区：${region.name}；国家：${country || "未指定，按地区检索"}`,
    `货描关键词建议：${keywords.join(" / ") || "待补充"}（可择一或组合）`,
    `建议期间：${dates.from} 至 ${dates.to}（最近12个月，平台可用范围待确认）`,
    `可选 WVA 核验线索：${draft.wva || "未指定"}；不设为货描必含词`,
    "候选核验：商用车业务、具体产品与适配、进口或采购角色及来源。地区不自动提高分级。",
    "HS 命中不能确认具体 SKU、适配或当前采购意向。",
    `条件来源：${SOURCE_URL}`,
  ].join("\n");
  const update = (patch: Partial<CustomsDraft>) => { onChange({ ...draft, ...patch }); setStatus(""); setError(""); };
  const copy = async () => {
    setError("");
    try { await navigator.clipboard.writeText(queryText); setStatus("检索条件已复制，可在授权平台逐项填写。"); }
    catch { previewRef.current?.focus(); previewRef.current?.select(); setStatus("浏览器未允许自动复制。已选中条件文本，请手动复制。"); }
  };
  const download = () => {
    setError("");
    try {
      const blob = new Blob([JSON.stringify({ ...task, generatedAt: new Date().toISOString() }, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `customs-search-${hsQuery}-${dates.to}.json`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setStatus("检索任务文件已生成并开始下载，文件中不包含凭证。");
    } catch { setError("任务文件未能下载，请先复制检索条件。"); }
  };

  return <Modal title="海关找客" description="按企业品类与目标市场生成检索条件，再到已授权的平台核查买家。" wide onClose={onClose}>
    <div className="ts-form ts-customs-form">
      <div className="ts-customs-source"><span><Globe2 size={16} />人工检索条件</span><ExternalLink url={SOURCE_URL}>查看官方 Q&A</ExternalLink></div>
      <div className="ts-form-grid">
        <label className="ts-field ts-span-2">产品方向<select value={draft.productId} onChange={event => { const selected = PRODUCTS.find(item => item.id === event.target.value)!; update({ productId: selected.id, keywords: selected.keywords, wva: "" }); }}>{PRODUCTS.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === "lining" ? " · 优先" : ""}</option>)}</select><small>{product.priority}</small></label>
        <label className="ts-field">企业提供 HS 原码<input readOnly value={product.hs} aria-label="企业提供 HS 原码" /></label>
        <label className="ts-field">本次查询粒度<select value={draft.hsLevel} onChange={event => update({ hsLevel: event.target.value as CustomsDraft["hsLevel"] })}><option value="six">前 6 位：{product.hs.slice(0, 6)}</option><option value="original">企业原码：{product.hs}</option></select></label>
        <label className="ts-field">目标地区<select value={draft.regionId} onChange={event => update({ regionId: event.target.value, country: "" })}><optgroup label="企业 Q&A 提及的主要市场">{REGIONS.slice(0, 4).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup><optgroup label="拟拓展地区">{REGIONS.slice(4).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup></select><small>{region.context}</small></label>
        <label className="ts-field">目标国家（可选）<input maxLength={100} value={draft.country} onChange={event => update({ country: event.target.value })} placeholder="留空则按所选地区检索" /><small>手填国家仅是本次目标，未认定为历史客户来源。</small></label>
        <label className="ts-field ts-span-2">货描关键词建议<input maxLength={300} value={draft.keywords} onChange={event => update({ keywords: event.target.value })} /><small>用分号分隔，可择一或组合；不强制货描包含型号。</small></label>
        <label className="ts-field">后续 WVA 核验线索（可选）<select value={draft.wva} onChange={event => update({ wva: event.target.value })}><option value="">不指定型号</option>{["19488", "19486", "19487", "19032"].map(code => <option key={code}>{code}</option>)}</select><small>询盘与企业材料重合的鼓式线索，仅用于后续核验；选其他品类时也不自动确认适配。</small></label>
        <div className="ts-field">建议检索期间<div className="ts-customs-period">最近 12 个月<span>{dates.from} — {dates.to}</span></div><small>实际数据范围在授权平台确认。</small></div>
      </div>
      <div className="ts-info-box ts-customs-scope"><ShieldCheck size={18} /><p>HS 前 6 位只是查询粒度，不能确认具体 SKU。北美、欧洲仅作拓展目标；按商用车业务、产品适配和采购角色核验，地区不自动加分。</p></div>
      <label className="ts-field ts-customs-preview">本次条件预览<textarea ref={previewRef} readOnly rows={6} value={queryText} /></label>
      <div className="ts-customs-actions"><Button onClick={copy}><Copy size={16} />复制条件</Button><Button onClick={download}><Download size={16} />下载任务 JSON</Button><a className="ts-button ts-button-primary" href={PLATFORM_URL} target="_blank" rel="noopener noreferrer">进入转单云后台<ArrowUpRight size={16} /></a></div>
      <p className="ts-form-note">同一浏览器仍有转单云登录状态时可直接进入；未登录或会话过期时由平台引导登录。此入口未接入海关查询 API，检索与核验在平台完成。</p>
      <div className="ts-customs-import"><div><strong>把授权导出表格带回工作台</strong><p>直接使用已授权平台导出的 CSV，或从 Excel 复制含表头的区域。确认进口商、HS、货描、国家和日期列后，先预览筛选结果，再勾选导入。</p></div><Button onClick={onImportCandidates}><FileSpreadsheet size={16} />导入海关原始表格</Button></div>
      {status && <p className="ts-customs-status" role="status">{status}</p>}
      {error && <p className="ts-inline-error" role="alert">{error}</p>}
      <footer className="ts-modal-footer"><span className="ts-customs-retain">本次选择在当前页面保留</span><Button onClick={onClose}>完成</Button></footer>
    </div>
  </Modal>;
}
