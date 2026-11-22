"use client";

import { FormEvent, useEffect, useState } from "react";
import Papa from "papaparse";
import { FileImage, FileSpreadsheet, Link2, UploadCloud } from "lucide-react";
import { Company, GRADE_LABELS, STAGES, formatDate, hostname, localInputDate, safeUrl } from "./types";
import { Button, Modal } from "./PlatformUI";

export type Mutation = (type: string, payload: Record<string, unknown>) => Promise<void>;

export function CompanyEditor({ company, companies = [], onOpenExisting, onSave, onClose, busy, error }: { company?: Company; companies?: Company[]; onOpenExisting?: (id: string) => void; onSave: Mutation; onClose: () => void; busy: boolean; error?: string }) {
  const [original] = useState(company);
  const [name, setName] = useState(company?.name || "");
  const [website, setWebsite] = useState(company?.website || "");
  const [duplicateAcknowledgement, setDuplicateAcknowledgement] = useState("");
  const [review, setReview] = useState<Array<{ name: string; before: string; after: string }> | null>(null);
  const [localError, setLocalError] = useState("");
  const normalizedName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const websiteDomain = (value?: string) => {
    try { return new URL(safeUrl(value?.trim()) || "").hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, ""); }
    catch { return ""; }
  };
  const sameNameCompanies = !original && normalizedName(name) ? companies.filter(item => normalizedName(item.name) === normalizedName(name)) : [];
  const domain = websiteDomain(website);
  const needsDuplicateAcknowledgement = sameNameCompanies.length > 0 && (!domain || sameNameCompanies.some(item => websiteDomain(item.website) === domain));
  const duplicateKey = JSON.stringify([normalizedName(name), domain, sameNameCompanies.map(item => `${item.id}:${websiteDomain(item.website)}`).sort()]);
  const duplicateAcknowledged = duplicateAcknowledgement === duplicateKey;
  const changedElsewhere = !!company && !!original && company.revision !== original.revision;
  const formError = changedElsewhere ? "客户资料已更新。请保留当前修改内容，关闭窗口后重新打开客户核对，避免覆盖新记录。" : localError || error;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || changedElsewhere) return;
    setLocalError("");
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) || "").trim();
    const due = text("nextFollowUpAt");
    if (!text("name")) { setLocalError("请填写企业名称，不能只输入空格。"); return; }
    if (needsDuplicateAcknowledgement && !duplicateAcknowledged) { setLocalError("已有同名客户，请先打开核对；确认是不同企业后，再勾选继续新建。"); return; }
    if (due && !Number.isFinite(Date.parse(due))) { setLocalError("请填写有效的下次跟进时间。"); return; }
    const payload = {
      ...(original ? { id: original.id, expectedRevision: original.revision } : {}), name: text("name"), website: safeUrl(text("website")) || text("website"),
      market: text("market"), buyerRole: text("buyerRole"), grade: text("grade"), stage: text("stage"), owner: text("owner"),
      productRefs: text("productRefs").split(/[,，;；\n]+/).map(x => x.trim()).filter(Boolean),
      nextAction: text("nextAction"), nextFollowUpAt: due ? new Date(due).toISOString() : "", notes: text("notes"),
      ...(!original ? { sourceKind: "manual" } : {}),
    };
    if (original && review === null) {
      const names = { name: "企业名称", website: "企业官网", market: "国家 / 市场", buyerRole: "买家角色", grade: "跟进分级", stage: "业务阶段", owner: "负责人", productRefs: "产品关联", nextAction: "下一步行动", nextFollowUpAt: "下次跟进", notes: "备注" };
      const comparable = (value: unknown) => Array.isArray(value) ? JSON.stringify(value) : String(value || "");
      const show = (value: unknown, key: string) => {
        if (key === "grade") return GRADE_LABELS[String(value || "unknown") as keyof typeof GRADE_LABELS] || "待补证";
        if (key === "nextFollowUpAt") return value ? formatDate(String(value), true) : "未安排";
        return Array.isArray(value) ? value.join(", ") || "未记录" : String(value || "未记录");
      };
      const keys = Object.keys(names) as Array<keyof typeof names>;
      const differences = keys.filter(key => comparable(original[key]) !== comparable(payload[key])).map(key => ({ name: names[key], before: show(original[key], key), after: show(payload[key], key) }));
      setReview(differences); return;
    }
    try { await onSave(original ? "update_company" : "create_company", payload); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : "保存未完成，输入内容已保留，请重试。"); }
  };
  return <Modal title={company ? "编辑客户与跟进安排" : "添加客户"} description="分级与阶段分别记录，采购意向保留原文依据。" onClose={onClose}>
    <form onSubmit={submit} className="ts-form" onChange={() => { setReview(null); setLocalError(""); }}>
      <div className="ts-form-grid">
        <h3 className="ts-span-2">主体信息</h3>
        <label className="ts-field ts-span-2">企业名称 <span className="ts-required">*</span><input name="name" required maxLength={160} value={name} onChange={event => { setName(event.target.value); setDuplicateAcknowledgement(""); }} placeholder="输入可识别的企业名称" /></label>
        <label className="ts-field ts-span-2">企业官网<input name="website" value={website} onChange={event => { setWebsite(event.target.value); setDuplicateAcknowledgement(""); }} placeholder="https://company.com" /></label>
        {sameNameCompanies.length > 0 && <section className="ts-span-2 ts-change-review" aria-label="同名客户提醒">
          <h3>已有同名客户，先核对是否同一家</h3>
          <p className="ts-form-note">{needsDuplicateAcknowledgement ? "缺少官网或官网域名相同，直接新建可能产生重复记录。" : "名称相同仍可能是不同企业，请核对官网与国家信息。"}不会自动合并或覆盖原客户。</p>
          {sameNameCompanies.map(item => <div key={item.id}><strong>{item.name}</strong><span>{item.market || "国家 / 市场未记录"} · {websiteDomain(item.website) || "官网未记录"}</span>{onOpenExisting && <Button type="button" onClick={() => onOpenExisting(item.id)} disabled={busy}>打开已有客户</Button>}</div>)}
          {needsDuplicateAcknowledgement && <label className="ts-form-note"><input type="checkbox" checked={duplicateAcknowledged} onChange={event => setDuplicateAcknowledgement(event.target.checked ? duplicateKey : "")} disabled={busy} /> 已核实为不同企业，继续新建</label>}
        </section>}
        <label className="ts-field">国家 / 市场<input name="market" defaultValue={company?.market} placeholder="例如：芬兰" /></label>
        <label className="ts-field">买家角色<input name="buyerRole" defaultValue={company?.buyerRole} placeholder="例如：进口商 / 待核验" /></label>
        <label className="ts-field ts-span-2">产品关联<input name="productRefs" defaultValue={company?.productRefs?.join(", ")} placeholder="例如：OE 3054005300, WVA 19477" /><small>多个型号用逗号分隔；产品关联不代表采购已确认。</small></label>
        <h3 className="ts-span-2">业务跟进</h3>
        <label className="ts-field">跟进分级<select name="grade" defaultValue={company?.grade || "unknown"}>{Object.entries(GRADE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="ts-field">业务阶段<select name="stage" defaultValue={company?.stage || "待研究"}>{STAGES.map(stage => <option key={stage}>{stage}</option>)}</select></label>
        <label className="ts-field">负责人<input name="owner" defaultValue={company?.owner} placeholder="业务员姓名" /></label>
        <label className="ts-field">下次跟进<input type="datetime-local" name="nextFollowUpAt" defaultValue={localInputDate(company?.nextFollowUpAt)} /></label>
        <label className="ts-field ts-span-2">下一步行动<input name="nextAction" defaultValue={company?.nextAction} placeholder="例如：确认采购部门与可接受订单量" /></label>
        <label className="ts-field ts-span-2">判断依据 / 备注<textarea name="notes" rows={3} defaultValue={company?.notes} placeholder="记录分级理由、已知条件或待核验事项" /></label>
      </div>
      <p className="ts-form-note">日期按当前设备时区显示，保存为 UTC。成交、报价与寄样阶段由业务员依据实际进展确认。</p>
      {review !== null && <section className="ts-change-review"><h3>确认本次资料变化</h3>{review.length ? review.map((item, index) => <div key={index}><strong>{item.name}</strong><span>{item.before}</span><span>{item.after}</span></div>) : <p>没有需要保存的变更。</p>}</section>}
      {formError && <p className="ts-inline-error" role="alert">{formError}</p>}
      <footer className="ts-modal-footer"><Button type="button" onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy} disabled={changedElsewhere || (needsDuplicateAcknowledgement && !duplicateAcknowledged) || (review !== null && review.length === 0)}>{company ? review === null ? "检查资料变化" : "确认保存变化" : "保存客户"}</Button></footer>
    </form>
  </Modal>;
}

type ImportTab = "csv" | "url" | "text" | "image";

export function ImportDialog({ onImport, onCreate, onClose, busy, error, initialTab }: { onImport: (csv: string) => Promise<void>; onCreate: Mutation; onClose: () => void; busy: boolean; error?: string; initialTab?: ImportTab }) {
  const [tab, setTab] = useState<ImportTab>(initialTab || "csv");
  const [draft, setDraft] = useState({ name: "", website: "", market: "", productRefs: "", sourceText: "" });
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [localError, setLocalError] = useState("");
  const updateDraft = (field: keyof typeof draft, value: string) => {
    setDraft(current => ({ ...current, [field]: value }));
    setLocalError("");
  };
  const parsed = csv.trim() ? Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }) : null;
  useEffect(() => {
    if (!imageFile) { setPreview(""); return; }
    const url = URL.createObjectURL(imageFile); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);
  const fileChanged = async (file?: File) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setLocalError("请导入 2 MB 以内的 CSV 文件。"); return; }
    try { const contents = await file.text(); setLocalError(""); setFileName(file.name); setCsv(contents); }
    catch { setLocalError("无法读取该文件。请重新选择 CSV，或直接粘贴内容；已有内容仍保留。"); }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return; setLocalError("");
    if (tab === "csv") {
      if (!csv.trim()) { setLocalError("请先选择 CSV 文件或粘贴表格文本。"); return; }
      if (parsed?.errors?.some(item => item.type === "Quotes")) { setLocalError("CSV 引号格式不完整，请检查后再导入。"); return; }
      try { await onImport(csv); }
      catch (cause) { setLocalError(cause instanceof Error ? cause.message : "导入未完成，CSV 内容已保留，请重试。"); }
      return;
    }
    const data = new FormData(event.currentTarget);
    const website = String(data.get("website") || "").trim();
    const name = String(data.get("name") || "").trim() || (tab === "url" ? hostname(website) : "");
    if (tab === "url" && !safeUrl(website)) { setLocalError("请输入有效的企业公开网址。"); return; }
    if (!name) { setLocalError("请填写已确认的企业名称；匿名昵称不能当作企业。"); return; }
    const sourceText = String(data.get("sourceText") || "").trim();
    try { await onCreate("create_company", {
      name, website: safeUrl(website) || "", sourceUrl: safeUrl(website) || "", market: String(data.get("market") || ""),
      sourceKind: tab === "url" ? "url_import" : tab === "image" ? "manual_transcript" : "manual_text",
      productRefs: String(data.get("productRefs") || "").split(/[,，;；\n]+/).map(x => x.trim()).filter(Boolean),
      grade: "unknown", stage: "待研究", notes: sourceText ? `${tab === "image" ? `已人工确认的图片转录（${imageFile?.name || "图片来源"}，原图未上传）：` : "导入原文："}\n${sourceText}` : "来自公开网址，企业主体、产品与买家角色待核验。",
    }); } catch (cause) { setLocalError(cause instanceof Error ? cause.message : "保存未完成，输入内容已保留，请重试。"); }
  };
  return <Modal title="导入客户线索" description="从授权资料或公开来源开始，保存后再核验产品与买家角色。" onClose={onClose} wide>
    <div className="ts-import-tabs" role="tablist" aria-label="导入方式">{([
      ["csv", "CSV / 表格", FileSpreadsheet], ["url", "企业网址", Link2], ["text", "复制原文", UploadCloud], ["image", "图片线索", FileImage],
    ] as const).map(([value, label, Icon]) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} disabled={busy} onClick={() => { setTab(value); setLocalError(""); }}><Icon size={17} />{label}</button>)}</div>
    <form onSubmit={submit} className="ts-form">
      {tab === "csv" ? <>
        <label className="ts-dropzone"><UploadCloud size={27} /><strong>{fileName || "选择 CSV 文件"}</strong><span>支持 UTF-8 CSV，也可在下方粘贴表格</span><input type="file" accept=".csv,text/csv,text/plain" onChange={event => fileChanged(event.target.files?.[0])} /></label>
        <label className="ts-field">CSV 内容<textarea className="ts-mono" rows={5} value={csv} onChange={event => setCsv(event.target.value)} placeholder={'name,website,market,productRefs\n企业名称,https://company.com,目标市场,OE 或 WVA 编号'} /></label>
        <p className="ts-form-note">推荐列：name、website、market、productRefs、buyerRole、owner、notes。只导入有授权的业务资料。</p>
        {parsed && parsed.data.length > 0 && <div className="ts-import-preview"><strong>预览 · {parsed.data.length} 行</strong><div className="ts-preview-scroll"><table><thead><tr>{(parsed.meta.fields || []).slice(0, 4).map(key => <th key={key}>{key}</th>)}</tr></thead><tbody>{parsed.data.slice(0, 3).map((row, index) => <tr key={index}>{(parsed.meta.fields || []).slice(0, 4).map(key => <td key={key}>{row[key] || "—"}</td>)}</tr>)}</tbody></table></div><small>最终导入与去重结果以服务端返回为准。</small></div>}
      </> : <>
        {tab === "image" && <>
          <div className="ts-info-box"><FileImage size={18} /><p>本版支持图片预览和人工确认编号。图片仅在当前浏览器预览，保存已确认的文字；未运行视觉识别或自动反向搜图。</p></div>
          <label className="ts-image-picker">{preview ? <img src={preview} alt="待人工确认的产品或来源图片" /> : <><FileImage size={28} /><span>选择产品图 / 来源截图</span></>}<input type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; if (file && file.size > 10 * 1024 * 1024) { setLocalError("请选择 10 MB 以内的图片。"); return; } setImageFile(file || null); setLocalError(""); }} /></label>
        </>}
        <div className="ts-form-grid">
          <h3 className="ts-span-2">主体信息</h3>
          <label className="ts-field ts-span-2">{tab === "url" ? "企业公开网址 *" : "来源网址（如有）"}<input name="website" value={draft.website} onChange={event => updateDraft("website", event.target.value)} required={tab === "url"} placeholder="https://company.com/product/..." /></label>
          <label className="ts-field">企业名称{tab !== "url" && " *"}<input name="name" value={draft.name} onChange={event => updateDraft("name", event.target.value)} required={tab !== "url"} placeholder={tab === "url" ? "未知时暂用域名，后续核验" : "已确认的企业名称"} /></label>
          <label className="ts-field">国家 / 市场<input name="market" value={draft.market} onChange={event => updateDraft("market", event.target.value)} placeholder="未知可留空" /></label>
          <h3 className="ts-span-2">线索依据</h3>
          <label className="ts-field ts-span-2">已知产品编号<input name="productRefs" value={draft.productRefs} onChange={event => updateDraft("productRefs", event.target.value)} placeholder="例如：WVA 29181, OE 3054005300" /></label>
          <label className="ts-field ts-span-2">{tab === "image" ? "人工核验后的原文 / 编号 *" : "原文或线索说明"}<textarea name="sourceText" value={draft.sourceText} onChange={event => updateDraft("sourceText", event.target.value)} required={tab === "image" || tab === "text"} rows={4} placeholder={tab === "image" ? "逐字核对图片中的企业名、编号与来源。不清楚的内容保留未知。" : "粘贴企业介绍、公开客户案例或已授权的业务原文"} /></label>
        </div>
        <p className="ts-form-note">同款经营企业与同行客户是不同关系；匿名评论与模糊昵称不能证明买家身份。</p>
      </>}
      {(localError || error) && <p className="ts-inline-error" role="alert">{localError || error}</p>}
      <footer className="ts-modal-footer"><Button type="button" onClick={onClose}>取消</Button><Button variant="primary" type="submit" busy={busy}>{tab === "csv" ? "导入并保存线索" : "保存待核验线索"}</Button></footer>
    </form>
  </Modal>;
}
