"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { AlertCircle, Check, CheckCircle2, ChevronDown, FileSpreadsheet, Filter, ListChecks, RefreshCw, Search, ShieldCheck, Upload } from "lucide-react";
import { Button, ExternalLink, Modal } from "./PlatformUI";
import type { PlatformState } from "./types";
import { CustomsCandidate, CustomsFilters, CustomsImportSummary, CustomsMapping, CustomsPreview, EMPTY_CUSTOMS_FILTERS, EMPTY_CUSTOMS_MAPPING } from "./customs-types";
import "./CustomsImport.css";

type Props = { onClose: () => void; onImported: (state: Partial<PlatformState>, summary: CustomsImportSummary) => void; initialFilters?: Partial<CustomsFilters> };
const MAX_BYTES = 500000;
const MAX_ROWS = 500;
const FIELDS: Array<{ key: keyof CustomsMapping; label: string; note: string; aliases: string[] }> = [
  { key: "companyName", label: "进口商 / 收货人名称", note: "必选。不要误选发货人或出口商。", aliases: ["importername", "buyername", "consigneename", "importer", "consignee", "buyer", "收货人名称", "进口商名称", "采购商名称", "收货人", "进口商", "采购商", "公司名称", "companyname", "name"] },
  { key: "hsCode", label: "HS / 商品编码", note: "保留原码，筛选时按前缀比较。", aliases: ["hscode", "hscodes", "hs", "htscode", "商品编码", "海关编码", "hs编码", "税则号"] },
  { key: "description", label: "货物描述", note: "用于关键词筛选，保留原文。", aliases: ["productdescription", "goodsdescription", "description", "commodity", "货物描述", "商品描述", "产品描述", "货描", "品名"] },
  { key: "country", label: "进口商 / 目的国", note: "不要误选出口国或原产国。", aliases: ["importercountry", "buyercountry", "consigneecountry", "destinationcountry", "country", "进口商国家", "收货国", "目的国", "进口国", "国家"] },
  { key: "date", label: "交易 / 到货日期", note: "接受明确的 YYYY-MM-DD 或 YYYY/MM/DD。", aliases: ["arrivaldate", "shipmentdate", "tradedate", "transactiondate", "date", "到货日期", "交易日期", "进口日期", "日期"] },
  { key: "website", label: "进口商官网", note: "选填。仅作为待核验网址。", aliases: ["importerwebsite", "buyerwebsite", "website", "官网", "企业网址", "公司网址"] },
  { key: "role", label: "企业角色原文", note: "选填。不会自动认定采购能力。", aliases: ["buyerrole", "companyrole", "role", "客户角色", "企业角色", "角色"] },
  { key: "supplier", label: "发货人 / 供应商", note: "选填。与进口商分开保留。", aliases: ["exportername", "suppliername", "shippername", "supplier", "shipper", "exporter", "发货人名称", "供应商名称", "出口商名称", "发货人", "供应商", "出口商"] },
];
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s_\-()（）:：]+/g, "");
function suggestMapping(headers: string[]): CustomsMapping {
  const result = { ...EMPTY_CUSTOMS_MAPPING };
  for (const field of FIELDS) result[field.key] = field.aliases.map(alias => headers.find(header => normalize(header) === normalize(alias))).find(Boolean) || "";
  return result;
}

export default function CustomsImport({ onClose, onImported, initialFilters }: Props) {
  const [text, setText] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [mapping, setMapping] = useState<CustomsMapping>({ ...EMPTY_CUSTOMS_MAPPING });
  const [filters, setFilters] = useState<CustomsFilters>({ ...EMPTY_CUSTOMS_FILTERS, ...initialFilters });
  const [dataClass, setDataClass] = useState<"" | "real" | "synthetic">("");
  const [authorized, setAuthorized] = useState(false);
  const [preview, setPreview] = useState<CustomsPreview | null>(null);
  const [previewBasis, setPreviewBasis] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "reading" | "preview" | "import">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<CustomsImportSummary | null>(null);
  const [page, setPage] = useState(0);
  const [encoding, setEncoding] = useState("utf-8");
  const fileInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const previousHeaders = useRef("");
  const previewRef = useRef<HTMLElement>(null);
  const bytes = useMemo(() => new TextEncoder().encode(text).byteLength, [text]);
  const parsed = useMemo(() => {
    if (!text.trim() || bytes > MAX_BYTES) return { headers: [] as string[], rows: 0, sample: [] as string[][], error: "" };
    const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { header: false, skipEmptyLines: "greedy", preview: MAX_ROWS + 2 });
    const headers = (result.data[0] || []).map(header => String(header || "").trim());
    const structuralError = result.errors.find(item => item.type === "Quotes");
    const headerError = headers.some(header => !header) ? "表头有空列名，请为列补齐名称，或在原表删除空列。" : new Set(headers).size !== headers.length ? "表头存在重复列名，请在原表改为不同名称后重试。" : "";
    return { headers, rows: Math.max(0, result.data.length - 1), sample: result.data.slice(1, 4), error: structuralError ? "表格引号结构不完整，请检查原 CSV，或直接从 Excel 复制含表头的区域。" : headerError };
  }, [text, bytes]);
  const headerKey = JSON.stringify(parsed.headers);
  useEffect(() => {
    if (headerKey !== previousHeaders.current) { previousHeaders.current = headerKey; setMapping(suggestMapping(parsed.headers)); setSelected([]); }
  }, [headerKey, parsed.headers]);
  useEffect(() => () => controller.current?.abort(), []);
  const requestInput = { text, sourceName: sourceName.trim(), authorized, dataClass, mapping, filters };
  const basis = JSON.stringify(requestInput);
  const outdated = !!preview && basis !== previewBasis;
  const localError = bytes > MAX_BYTES ? `表格超过 500,000 UTF-8 字节（当前 ${bytes.toLocaleString()} 字节），请拆分后导入。` : parsed.rows > MAX_ROWS ? "数据超过 500 行，请拆分导出或粘贴区域。" : parsed.error;
  const valid = text.trim() && parsed.rows > 0 && !localError && sourceName.trim() && mapping.companyName && authorized && dataClass;
  const mutateFilters = (key: keyof CustomsFilters, value: string) => { setFilters(current => ({ ...current, [key]: value })); setError(""); setNotice(""); };
  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return; setError(""); setNotice("");
    if (/\.xlsx?$/i.test(file.name)) { setError("当前直接支持 CSV / TSV 文本。请把 Excel 另存为 CSV，或复制包含表头的区域粘贴到下方；尚未解析这份 Excel 文件。"); event.target.value = ""; return; }
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) { setError("请选择 .csv、.tsv 或 .txt 文件，或直接粘贴 Excel 表格。"); event.target.value = ""; return; }
    if (file.size > MAX_BYTES) { setError("文件超过 500,000 字节，请先拆分；当前输入内容已保留。"); event.target.value = ""; return; }
    setBusy("reading");
    try {
      const decoded = new TextDecoder(encoding, { fatal: true }).decode(await file.arrayBuffer()).replace(/^\uFEFF/, "");
      if (new TextEncoder().encode(decoded).byteLength > MAX_BYTES) throw new Error("转换为 UTF-8 后超过 500,000 字节，请拆分文件。旧内容已保留。");
      setText(decoded); setSourceName(file.name); setDataClass(""); setAuthorized(false); setReceipt(null); setSelected([]); setNotice(`已在浏览器读取 ${file.name}；尚未导入客户。请核对字段映射与数据类别。`);
    } catch(cause) { setError(cause instanceof Error && cause.name !== "TypeError" ? cause.message : "无法按所选编码读取。可选择 GB18030 后重新选文件，或另存为 UTF-8 CSV / 复制粘贴。旧内容已保留。"); }
    finally { setBusy(""); event.target.value = ""; }
  };
  const execute = async (mode: "preview" | "import") => {
    if (busy || !valid) return;
    if (mode === "import" && (!preview || outdated || !selected.length || receipt)) return;
    setError(""); setNotice(""); setBusy(mode);
    const submittedBasis = basis; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 30000);
    try {
      const response = await fetch("/api/platform/customs-import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, ...requestInput, ...(mode === "import" ? { previewHash: preview!.previewHash, selectedKeys: selected } : {}) }), signal: abort.signal });
      const body = await response.json() as { ok?: boolean; result?: CustomsPreview; data?: Partial<PlatformState>; meta?: CustomsImportSummary; error?: { message?: string } };
      if (!response.ok || !body.ok) throw new Error(body.error?.message || `操作未完成（${response.status}）。`);
      if (mode === "preview") {
        if (!body.result) throw new Error("服务没有返回有效预览，没有生成替代结果。");
        setPreview(body.result); setPreviewBasis(submittedBasis); setSelected([]); setReceipt(null); setPage(0);
        setNotice("服务端预览已完成。候选尚未导入，请展开来源记录并选择要保留的公司。");
        setTimeout(() => previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
      } else {
        if (!body.data || !body.meta) throw new Error("保存响应不完整，请刷新客户工作台核对导入状态；不要重复盲目提交。");
        setReceipt(body.meta); setNotice("已按服务端重新核验的结果保存。所有新客户仍为待核验，未认定采购能力或意向。"); onImported(body.data, body.meta);
      }
    } catch(cause) { setError(cause instanceof Error && cause.name === "AbortError" ? mode === "import" ? "导入请求超时，保存状态暂不确定。请先刷新客户工作台核对；再次导入仍会经过来源去重。" : "预览请求超时，输入内容已保留，可重新预览。" : cause instanceof Error ? cause.message : "操作未完成，输入内容已保留。"); }
    finally { clearTimeout(timeout); setBusy(""); }
  };
  const close = () => { if (busy === "import") { setError("正在确认导入结果，请等待当前请求结束再关闭。"); return; } controller.current?.abort(); onClose(); };
  const editable = !busy;
  const selectableCandidates = preview?.candidates.filter(candidate => !candidate.identityConflict) || [];
  const allSelected = !!selectableCandidates.length && selectableCandidates.every(candidate => selected.includes(candidate.key));

  return <Modal title="导入海关原始表格" description="从已授权的导出文件开始，核对字段、筛选记录，再选择需要研究的企业。" wide onClose={close}><div className="customs-import-body">
    <div className="ci-workflow"><span className={text ? "active" : ""}><Upload size={16} />读取与映射</span><span className={preview && !outdated ? "active" : ""}><Filter size={16} />真实预览</span><span className={receipt ? "active" : ""}><ListChecks size={16} />勾选后导入</span></div>
    {error && <div className="ci-message is-error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}{notice && <div className="ci-message" role="status"><CheckCircle2 size={18} /><span>{notice}</span></div>}
    <section className="ci-section"><div className="ci-section-heading"><div><h3>原始表格</h3><p>CSV / TSV，最多 500 行、500,000 UTF-8 字节；Excel 可复制含表头的区域。</p></div></div>
      <div className="ci-file-row"><input ref={fileInput} className="ci-hidden-file" type="file" accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv,text/tab-separated-values" onChange={readFile} disabled={!editable} /><Button onClick={() => fileInput.current?.click()} disabled={!editable} busy={busy === "reading"}><FileSpreadsheet size={17} />选择文件</Button><label><span>文件编码</span><select value={encoding} onChange={event => setEncoding(event.target.value)} disabled={!editable}><option value="utf-8">UTF-8</option><option value="gb18030">GB18030 / GBK</option></select></label><span>Excel 文件请另存为 CSV 或复制粘贴，不直接解析 .xlsx。</span></div>
      <label className="ci-field"><span>粘贴原表 · 第一行保留列名</span><textarea rows={6} value={text} onChange={event => { setText(event.target.value); setDataClass(""); setAuthorized(false); setError(""); setNotice(""); setReceipt(null); }} disabled={!editable} placeholder={"支持从 Excel 复制粘贴，或粘贴 CSV 文本。\n原表保持原样，不需要先改成平台专用列名。"} spellCheck={false} /><small>{bytes.toLocaleString()} / 500,000 字节{parsed.rows ? ` · 识别到 ${parsed.rows > MAX_ROWS ? "超过 500" : parsed.rows} 行数据` : ""} · 这里只读取表格，尚未保存客户。</small></label>
      {localError && <p className="ci-local-error" role="alert">{localError}</p>}
      <div className="ci-context-grid"><label className="ci-field"><span>来源名称 *</span><input value={sourceName} maxLength={200} disabled={!editable} onChange={event => { setSourceName(event.target.value); setReceipt(null); }} placeholder="平台导出文件名或企业授权数据批次" /></label><label className="ci-field"><span>数据类别 *</span><select value={dataClass} disabled={!editable} onChange={event => { setDataClass(event.target.value as "real" | "synthetic" | ""); setReceipt(null); setAuthorized(false); }}><option value="">请选择，避免混入测试数据</option><option value="real">企业授权的真实数据</option><option value="synthetic">测试 / 演示数据，独立标记</option></select></label></div>
      <label className="ci-consent"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} disabled={!editable} /><span>{dataClass === "synthetic" ? "这些是测试资料，我确认它们会作为测试来源保存，不作为真实客户或交易证据。" : "我确认有权使用这份公开或已授权资料，并允许按当前筛选条件处理。"}</span></label>
    </section>
    {!!parsed.headers.length && !localError && <section className="ci-section"><div className="ci-section-heading"><div><h3>确认每一列代表什么</h3><p>系统只建议对应列；请重点核对进口商名称、目的国与日期。</p></div><Button variant="quiet" onClick={() => setMapping(suggestMapping(parsed.headers))} disabled={!editable}><RefreshCw size={15} />恢复列名建议</Button></div><div className="ci-mapping-grid">{FIELDS.map(field => <label className="ci-field" key={field.key}><span>{field.label}{field.key === "companyName" ? " *" : ""}</span><select value={mapping[field.key]} onChange={event => setMapping(current => ({ ...current, [field.key]: event.target.value }))} disabled={!editable}><option value="">{field.key === "companyName" ? "必须选择原表中的公司名称列" : "此字段不映射"}</option>{parsed.headers.map(header => <option key={header} value={header}>{header}</option>)}</select><small>{field.note}{mapping[field.key] && parsed.sample[0]?.[parsed.headers.indexOf(mapping[field.key])] ? <em>首行示例：{String(parsed.sample[0][parsed.headers.indexOf(mapping[field.key])]).slice(0, 90)}</em> : null}</small></label>)}</div></section>}
    <section className="ci-section"><div className="ci-section-heading"><div><h3>先筛记录，再看候选</h3><p>填写的条件同时满足；留空不限制该项。</p></div><Button variant="quiet" onClick={() => { setFilters({ ...EMPTY_CUSTOMS_FILTERS }); setError(""); }} disabled={!editable}>清空筛选</Button></div><div className="ci-filter-grid"><label className="ci-field"><span>HS 前缀</span><input value={filters.hsPrefix} onChange={event => mutateFilters("hsPrefix", event.target.value)} disabled={!editable} placeholder="例如 681381" maxLength={20} /><small>HS 只用于类别筛选，不能确定适配。</small></label><label className="ci-field"><span>货描关键词</span><input value={filters.keyword} onChange={event => mutateFilters("keyword", event.target.value)} disabled={!editable} placeholder="一个原文词或短语，如 brake lining" maxLength={160} /><small>按字面包含匹配，不做型号联想。</small></label><label className="ci-field"><span>进口商 / 目的国</span><input value={filters.country} onChange={event => mutateFilters("country", event.target.value)} disabled={!editable} placeholder="按原表国家名称填写" maxLength={100} /><small>不自动合并国家简称或中英文别名。</small></label><label className="ci-field"><span>起始日期（含）</span><input value={filters.dateFrom} onChange={event => mutateFilters("dateFrom", event.target.value)} type="date" disabled={!editable} /></label><label className="ci-field"><span>结束日期（含）</span><input value={filters.dateTo} onChange={event => mutateFilters("dateTo", event.target.value)} type="date" disabled={!editable} /><small>使用日期筛选时，无法确定的日期不通过。</small></label></div><div className="ci-preview-action"><Button variant="primary" onClick={() => execute("preview")} disabled={!!busy || !valid} busy={busy === "preview"}><Search size={16} />按当前条件预览</Button><span>{!text.trim() ? "先提供表格" : !sourceName.trim() ? "请填写来源名称" : !mapping.companyName ? "请映射公司名称列" : !dataClass ? "请选择真实或测试数据" : !authorized ? "请确认资料使用授权" : "服务端读取与筛选，不调用模型"}</span></div></section>
    {preview && <section className="ci-section ci-preview-section" ref={previewRef}><div className="ci-section-heading"><div><h3>预览结果</h3><p>企业只是后续研究候选，尚未认定采购能力、当前需求或适配。</p></div><span className={`ci-preview-state ${outdated ? "outdated" : ""}`}>{outdated ? "条件已变，重新预览" : "服务端预览"}</span></div>{outdated && <div className="ci-message is-warning"><AlertCircle size={17} /><span>表格、映射、来源、类别或筛选已改变，旧结果不能导入。</span></div>}<div className="ci-stats">{[["原始数据", preview.summary.inputRows], ["满足筛选", preview.summary.matchedRows], ["被筛除", preview.summary.filteredRows], ["无效行", preview.summary.invalidRows], ["重复行", preview.summary.duplicateRows], ["候选企业", preview.summary.candidateCount]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      {preview.candidates.length ? <><div className="ci-selection"><label><input type="checkbox" checked={allSelected} onChange={event => setSelected(event.target.checked ? selectableCandidates.map(candidate => candidate.key) : [])} disabled={!!busy || outdated || !!receipt} /><span>选择当前预览的全部可导入候选</span></label><span>已选 {selected.length} / {selectableCandidates.length} 家可导入候选</span></div><div className="ci-candidates">{preview.candidates.slice(page * 20, (page + 1) * 20).map(candidate => <CandidateRow key={candidate.key} candidate={candidate} selected={selected.includes(candidate.key)} disabled={!!busy || outdated || !!receipt || !!candidate.identityConflict} onSelect={checked => setSelected(current => checked ? [...current, candidate.key] : current.filter(key => key !== candidate.key))} />)}</div>{preview.candidates.length > 20 && <div className="ci-pagination"><Button onClick={() => setPage(current => current - 1)} disabled={!!busy || page === 0}>上一页</Button><span>第 {page + 1} / {Math.ceil(preview.candidates.length / 20)} 页 · 选择会跨页保留</span><Button onClick={() => setPage(current => current + 1)} disabled={!!busy || (page + 1) * 20 >= preview.candidates.length}>下一页</Button></div>}</> : <div className="ci-empty"><Search size={26} /><strong>当前条件下没有可导入的候选</strong><p>查看拒绝原因，检查字段映射或调整筛选；不会自动放宽条件。</p></div>}
      {!!preview.errors.length && <details className="ci-errors"><summary><AlertCircle size={16} /><span>查看原表行与拒绝原因（{preview.errors.length}）</span><ChevronDown size={15} /></summary>{preview.errors.map((item, index) => <div key={`${item.row}-${index}`}><strong>第 {item.row} 行</strong><p>{item.message}</p><code>{item.code}</code></div>)}</details>}
      {preview.notice && <p className="ci-source-note"><ShieldCheck size={16} />{preview.notice}</p>}
      {!receipt && <div className="ci-import-action"><div><strong>{dataClass === "synthetic" ? "将作为测试来源导入" : "将作为待核验客户导入"}</strong><p>服务器会重新筛选并验证预览内容；重复来源不会重复增加。</p></div><Button variant="primary" onClick={() => execute("import")} disabled={!!busy || !valid || outdated || !selected.length} busy={busy === "import"}><Check size={16} />确认导入 {selected.length} 家</Button></div>}
    </section>}
    {receipt && <section className="ci-receipt" role="status"><CheckCircle2 size={26} /><div><h3>导入完成</h3><p>新增 {receipt.importedCompanies} 家 · 合并 {receipt.mergedCompanies} 家 · 新增来源记录 {receipt.importedRecords} 条 · 跳过重复 {receipt.duplicateRecords} 条</p><small>批次：{receipt.batchId}</small><p>所有新客户均为待核验，可在客户工作台继续核对产品与采购角色。</p></div></section>}
    <footer className="ci-footer"><span>本次只处理授权导出表格，不直接查询海关平台。</span><Button onClick={close} disabled={busy === "import"}>{receipt ? "完成，返回工作台" : "关闭"}</Button></footer>
  </div></Modal>;
}

function CandidateRow({ candidate, selected, disabled, onSelect }: { candidate: CustomsCandidate; selected: boolean; disabled: boolean; onSelect: (checked: boolean) => void }) {
  return <article className={`ci-candidate ${selected ? "selected" : ""}`}><div className="ci-candidate-heading"><label><input type="checkbox" checked={selected} disabled={disabled} onChange={event => onSelect(event.target.checked)} aria-label={`选择 ${candidate.name}`} /><span><strong>{candidate.name}</strong><small>{candidate.country || "国家未提供"} · {candidate.recordCount} 条符合条件的记录</small></span></label><span className="ci-unverified">{candidate.identityConflict ? "身份待拆分，暂不导入" : "待核验"}</span></div><div className="ci-candidate-meta"><span>HS：{candidate.hsCodes.join(" / ") || "未提供"}</span>{candidate.role && <span>角色原文：{candidate.role}</span>}{candidate.website && <ExternalLink url={candidate.website}>来源网址</ExternalLink>}</div>{candidate.descriptions[0] && <p className="ci-description">{candidate.descriptions[0]}</p>}{!!candidate.warnings.length && <p className="ci-warning-text">{candidate.warnings.join("；")}</p>}<details className="ci-original-rows"><summary>查看来源行（{candidate.sourceRows.slice(0, 8).join("、")}{candidate.sourceRows.length > 8 ? ` 等 ${candidate.sourceRows.length} 行` : ""}）<ChevronDown size={14} /></summary><div className="ci-row-scroll"><table><thead><tr><th>原表行</th><th>HS 原码</th><th>货描原文</th><th>日期</th><th>供应商原文</th></tr></thead><tbody>{candidate.records.map((record, index) => <tr key={`${record.row}-${index}`}><td>{record.row}</td><td><code>{record.hsCode || "—"}</code></td><td>{record.description || "—"}</td><td>{record.date || record.dateRaw || "—"}</td><td>{record.supplier || "—"}</td></tr>)}</tbody></table></div></details></article>;
}
