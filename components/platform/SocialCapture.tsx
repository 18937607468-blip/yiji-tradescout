"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, FileImage, FileText, ImageIcon, Link2, MessageSquareText, Save, ShieldCheck, Upload, X } from "lucide-react";
import { Button, ExternalLink, Modal } from "./PlatformUI";
import { Company, PlatformState, formatDate } from "./types";
import type { SocialAttachment, SocialChannel, SocialDataClass, SocialSaveMeta, SocialSource } from "./social-types";
import "./SocialCapture.css";

type Props = { state: PlatformState; onClose: () => void; onSaved: (state: Partial<PlatformState>, meta: SocialSaveMeta) => void };
const CHANNELS: SocialChannel[] = ["视频号", "微信", "Facebook", "WhatsApp", "MIC", "其他"];
const MAX_ORIGINAL = 10 * 1024 * 1024;
const MAX_STORED = 200 * 1024;
const MAX_TEXT = 16000;
const bytesLabel = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
const companyClass = (company: Company) => company.dataClass === "synthetic" || company.isDemo === true ? "synthetic" : "real";

export async function compressSocialScreenshot(file: File): Promise<SocialAttachment> {
  if (file.size > MAX_ORIGINAL) throw new Error("原图超过 10 MB。请先裁剪到相关对话后再上传；当前内容已保留。");
  const original = await file.arrayBuffer();
  const signature = new Uint8Array(original.slice(0, 12));
  const png = signature[0] === 137 && signature[1] === 80 && signature[2] === 78 && signature[3] === 71;
  const jpeg = signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
  const webp = String.fromCharCode(...signature.slice(0, 4)) === "RIFF" && String.fromCharCode(...signature.slice(8, 12)) === "WEBP";
  if (!png && !jpeg && !webp) throw new Error("请上传有效 PNG、JPEG 或 WebP 截图；文件后缀不能替代真实图片格式。");
  const digest = await crypto.subtle.digest("SHA-256", original);
  const originalSha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  const localUrl = URL.createObjectURL(file); const image = new window.Image();
  try {
    image.src = localUrl; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 60000000) throw new Error("图片尺寸过大或无法读取，请裁剪为相关对话区域后重试。");
    const canvas = document.createElement("canvas"); const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法生成压缩预览，请换用 PNG/JPEG 小图或先录入文字。");
    for (const longest of [1600, 1200, 900, 680]) {
      const ratio = Math.min(1, longest / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.9, 0.75, 0.6, 0.45, 0.3]) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
        if (!blob || blob.size > MAX_STORED) continue;
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("无法读取压缩预览，请重试。")); reader.readAsDataURL(blob); });
        return { dataUrl, fileName: file.name, mime: "image/jpeg", originalSha256, originalSize: file.size, width: canvas.width, height: canvas.height, storedBytes: blob.size, compressed: true };
      }
    }
    throw new Error("无法压缩到 200 KB 以内，请裁剪截图后重试；没有保存原图。");
  } finally { URL.revokeObjectURL(localUrl); image.src = ""; }
}

export default function SocialCapture({ state, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<"capture" | "saved">("capture");
  const [channel, setChannel] = useState<SocialChannel>("WhatsApp");
  const [sourceName, setSourceName] = useState("");
  const [handle, setHandle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [text, setText] = useState("");
  const [captureMethod, setCaptureMethod] = useState<"paste" | "text_file" | "screenshot">("paste");
  const [attachment, setAttachment] = useState<SocialAttachment | null>(null);
  const [originalUrl, setOriginalUrl] = useState("");
  const [screenshotChecked, setScreenshotChecked] = useState(false);
  const [dataClass, setDataClass] = useState<SocialDataClass | "">("");
  const [companyId, setCompanyId] = useState("");
  const [companyConfirmed, setCompanyConfirmed] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<SocialSaveMeta | null>(null);
  const [savedOnlyPending, setSavedOnlyPending] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const textInput = useRef<HTMLInputElement>(null); const imageInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const sources = (state.socialSources || []) as unknown as SocialSource[];
  const compatibleCompanies = state.companies.filter(company => companyClass(company) === dataClass);
  const pendingCount = sources.filter(source => !source.companyId).length;
  const visibleSources = [...sources].filter(source => !savedOnlyPending || !source.companyId).reverse();
  useEffect(() => () => { if (originalUrl) URL.revokeObjectURL(originalUrl); }, [originalUrl]);
  useEffect(() => () => controller.current?.abort(), []);
  const changed = () => { setReceipt(null); setNotice(""); setError(""); };
  const readTextFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return; setError(""); setNotice("");
    if (!/\.txt$/i.test(file.name)) { setError("请选 UTF-8 .txt 文件；其他格式请直接复制可见文字。"); event.target.value = ""; return; }
    if (file.size > 128 * 1024) { setError("文本文件过大，请仅截取相关原文（最多 16,000 字符）。已有内容保留。"); event.target.value = ""; return; }
    setBusy("read-text");
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()).replace(/^\uFEFF/, "");
      if (!value.trim() || value.length > MAX_TEXT) throw new Error("TXT 需有可见原文且不超过 16,000 字符；请截取相关内容再读取。");
      setText(value); setCaptureMethod(attachment ? "screenshot" : "text_file"); setSourceName(current => current || file.name); setDataClass(""); setAuthorized(false); setCompanyId(""); setCompanyConfirmed(false); setScreenshotChecked(false); setReceipt(null); setNotice("TXT 已在浏览器读取，尚未保存。请核对渠道、发生时间和原文。");
    } catch(cause) { setError(cause instanceof Error && cause.name !== "TypeError" ? cause.message : "文件不是可读取的 UTF-8 文本。请另存 UTF-8 TXT 或直接复制粘贴；旧内容已保留。"); }
    finally { setBusy(""); event.target.value = ""; }
  };
  const readScreenshot = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return; setError(""); setNotice(""); setBusy("compress-image");
    try {
      const result = await compressSocialScreenshot(file);
      setAttachment(result); setOriginalUrl(URL.createObjectURL(file)); setCaptureMethod("screenshot"); setSourceName(current => current || file.name); setScreenshotChecked(false); setDataClass(""); setAuthorized(false); setCompanyId(""); setCompanyConfirmed(false); setReceipt(null);
      setNotice("已生成不超过 200 KB 的 JPEG 压缩副本。未执行 OCR，请对照原图录入或核对可见原文。");
    } catch(cause) { setError(cause instanceof Error ? cause.message : "图片处理失败，旧内容已保留。"); }
    finally { setBusy(""); event.target.value = ""; }
  };
  const submit = async (payload: Record<string, unknown>) => {
    const abort = new AbortController(); controller.current = abort; const timeout = setTimeout(() => abort.abort(), 30000);
    try {
      const response = await fetch("/api/platform/social-capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: abort.signal });
      const body = await response.json() as { ok?: boolean; data?: Partial<PlatformState>; meta?: SocialSaveMeta; error?: {message?:string} };
      if (!response.ok || !body.ok || !body.data || !body.meta) throw new Error(body.error?.message || "保存响应不完整，请刷新工作台核对实际保存状态。");
      onSaved(body.data, body.meta); return body.meta;
    } catch(cause) { throw new Error(cause instanceof Error && cause.name === "AbortError" ? "请求超时，保存状态暂不确定。输入已保留，请先查看已存资料，再决定是否重试。" : cause instanceof Error ? cause.message : "资料未保存，输入内容已保留。"); }
    finally { clearTimeout(timeout); }
  };
  const save = async () => {
    if (busy) return; setError(""); setNotice("");
    if (!sourceName.trim() || !text.trim()) { setError("请填写来源名称和人工核对过的原文；截图不会自动转成文字。"); return; }
    if (text.length > MAX_TEXT) { setError("原文超过 16,000 字符，请拆成独立资料后保存。"); return; }
    if (!dataClass || !authorized) { setError("请选择真实或测试资料，并确认有权使用这份资料。"); return; }
    if (attachment && !screenshotChecked) { setError("请先对照截图核对可见原文，并勾选核对确认。"); return; }
    if (companyId && !companyConfirmed) { setError("需要人工确认来源属于所选企业；暂不确定时可选择待核对。"); return; }
    if (occurredAt && !Number.isFinite(Date.parse(occurredAt))) { setError("请填写有效发生时间，或留空表示未知。"); return; }
    setBusy("save");
    try {
      const meta = await submit({ mode: "save", channel, handle, captureMethod: attachment ? "screenshot" : captureMethod, sourceName: sourceName.trim(), sourceUrl, occurredAt: occurredAt ? new Date(occurredAt).toISOString() : "", text, authorized: true, dataClass, ...(companyId ? { companyId, companyConfirmed: true } : {}), ...(attachment ? { attachment } : {}) });
      setReceipt(meta); setNotice(meta.notice || (meta.duplicate ? "资料已经保存过，没有重复增加。" : "资料已保存，当前输入仍保留供核对。"));
    } catch(cause) { setError(cause instanceof Error ? cause.message : "保存未完成，输入已保留。"); }
    finally { setBusy(""); }
  };
  const link = async (source: SocialSource, company: string) => {
    if (busy) return; setBusy(`link:${source.id}`); setError(""); setNotice("");
    try { const meta = await submit({mode:"link",id:source.id,expectedRevision:source.revision,companyId:company,companyConfirmed:true,authorized:true}); setNotice(meta.notice || "已将这条资料关联到人工确认的企业。"); }
    catch(cause) { const message = cause instanceof Error ? cause.message : "关联未完成，请重试。"; setError(message); throw new Error(message); }
    finally {setBusy("");}
  };
  const clear = () => { setSourceName(""); setHandle(""); setSourceUrl(""); setOccurredAt(""); setText(""); setCaptureMethod("paste"); setAttachment(null); setOriginalUrl(""); setScreenshotChecked(false); setDataClass(""); setCompanyId(""); setCompanyConfirmed(false); setAuthorized(false); setReceipt(null); setError(""); setNotice(""); setClearConfirm(false); };
  const close = () => { if (busy) { setError("当前操作仍在进行，请等待结果后再关闭，输入会保留。"); return; } onClose(); };

  return <Modal title="社媒资料录入" description="把授权文字与截图留成可回看的来源，再人工确认它属于哪家企业。" onClose={close} wide><div className="social-capture-body">
    <div className="social-tabs" role="tablist"><button className={tab === "capture" ? "active" : ""} onClick={() => setTab("capture")} role="tab" aria-selected={tab === "capture"}><Upload size={17} />录入新资料</button><button className={tab === "saved" ? "active" : ""} onClick={() => setTab("saved")} role="tab" aria-selected={tab === "saved"}><MessageSquareText size={17} />已存资料 <span>{sources.length}</span>{pendingCount > 0 && <small>{pendingCount} 条待关联</small>}</button></div>
    {error && <p className="social-message error" role="alert"><AlertCircle size={18} />{error}</p>}{notice && <p className="social-message" role="status"><CheckCircle2 size={18} />{notice}</p>}
    {tab === "capture" ? <div className="social-form">
      <div className="social-intake"><div><strong>保留原话，保留出处</strong><p>可粘贴文字、读取 UTF-8 TXT，或上传截图后人工录字。</p></div><div><input ref={textInput} type="file" accept=".txt,text/plain" hidden onChange={readTextFile} disabled={!!busy} /><input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hidden onChange={readScreenshot} disabled={!!busy} /><Button onClick={() => textInput.current?.click()} disabled={!!busy} busy={busy === "read-text"}><FileText size={16} />读取 TXT</Button><Button onClick={() => imageInput.current?.click()} disabled={!!busy} busy={busy === "compress-image"}><FileImage size={16} />上传截图</Button></div></div>
      <div className="social-fields"><label><span>渠道</span><select value={channel} onChange={event => {setChannel(event.target.value as SocialChannel);setCompanyConfirmed(false);changed();}} disabled={!!busy}>{CHANNELS.map(value => <option key={value}>{value}</option>)}</select></label><label><span>来源名称 *</span><input value={sourceName} onChange={event => {setSourceName(event.target.value);setCompanyConfirmed(false);changed();}} maxLength={200} disabled={!!busy} placeholder="例如：展会后 WhatsApp 询价" /></label><label><span>社媒昵称 <small>不代表企业身份</small></span><input value={handle} onChange={event => {setHandle(event.target.value);setCompanyConfirmed(false);changed();}} maxLength={160} disabled={!!busy} placeholder="保留原昵称，不据此创建公司" /></label><label><span>实际发生时间 <small>未知可留空</small></span><input type="datetime-local" value={occurredAt} onChange={event => {setOccurredAt(event.target.value);changed();}} disabled={!!busy} /><small>按当前设备时区保存；资料保存时间另外记录。</small></label><label className="social-span"><span>来源链接 <small>可选</small></span><input value={sourceUrl} onChange={event => {setSourceUrl(event.target.value);setCompanyConfirmed(false);changed();}} type="url" maxLength={2048} disabled={!!busy} placeholder="原帖子或可回看的授权来源地址" /></label></div>
      {attachment && <section className="social-image-proof"><div className="social-image-head"><div><ImageIcon size={17} /><strong>截图存证 · 未执行 OCR</strong></div><button className="social-icon-button" aria-label="移除当前截图" disabled={!!busy} onClick={() => {setAttachment(null);setOriginalUrl("");setCaptureMethod("paste");setScreenshotChecked(false);changed();}}><X size={18} /></button></div><div className="social-image-grid"><figure><img src={attachment.dataUrl} alt="待保存的压缩截图预览" /><figcaption>将保存的 JPEG 压缩副本 · {attachment.width} × {attachment.height}</figcaption></figure><div><strong>{attachment.fileName}</strong><p>原图 {bytesLabel(attachment.originalSize)} · 压缩副本 {bytesLabel(attachment.storedBytes)}</p><p>服务器只存压缩副本。原图核对入口仅在当前浏览器可用，未上传原图。</p>{originalUrl && <a href={originalUrl} target="_blank" rel="noopener noreferrer" className="ts-button ts-button-secondary">打开本次原图核对</a>}<details><summary>查看原图校验信息</summary><code>SHA-256 {attachment.originalSha256}</code><small>用于识别来源原件；不能从哈希恢复原图。</small></details></div></div></section>}
      <label className="social-text-field"><span>{attachment ? "核对并录入截图中可见的原文 *" : "粘贴或录入授权原文 *"}</span><textarea value={text} onChange={event => {setText(event.target.value);setCompanyConfirmed(false);setScreenshotChecked(false);if(!attachment)setCaptureMethod("paste");changed();}} rows={7} disabled={!!busy} placeholder={attachment ? "请对照原图手动录入可见文字，不补猜被遮挡的型号、数量或日期。上传截图不会自动识别文字。" : "保留客户原话、型号、数量与疑问。昵称相似或聊天内容本身不会自动证明公司身份、采购能力或成交。"} /><small>{text.length.toLocaleString()} / 16,000 字符；来源原文与后续判断分别记录。</small></label>
      {attachment && <label className="social-check"><input type="checkbox" checked={screenshotChecked} disabled={!!busy} onChange={event => setScreenshotChecked(event.target.checked)} /><span>我已对照截图核对上面的可见原文，没有把未知内容补成事实。</span></label>}
      <div className="social-association"><div className="social-section-title"><ShieldCheck size={17} /><h3>确认资料类别与企业归属</h3></div><div className="social-fields"><label><span>资料类别 *</span><select value={dataClass} onChange={event => {setDataClass(event.target.value as SocialDataClass | "");setCompanyId("");setCompanyConfirmed(false);setAuthorized(false);changed();}} disabled={!!busy}><option value="">请选择，避免真实与测试混用</option><option value="real">企业授权的真实资料</option><option value="synthetic">测试 / 演示资料</option></select></label><label><span>关联已有企业 <small>不确定就留待核对</small></span><select value={companyId} onChange={event => {setCompanyId(event.target.value);setCompanyConfirmed(false);changed();}} disabled={!!busy || !dataClass}><option value="">尚未确认企业身份 · 留待核对</option>{compatibleCompanies.map(company => <option value={company.id} key={company.id}>{company.name}</option>)}</select><small>仅列出相同真实 / 测试类别的企业；不根据昵称自动关联。</small></label></div>{companyId && <label className="social-check"><input type="checkbox" checked={companyConfirmed} onChange={event => {setCompanyConfirmed(event.target.checked);changed();}} disabled={!!busy} /><span>我已核对资料来源，确认它属于所选企业。</span></label>}<label className="social-check"><input type="checkbox" checked={authorized} onChange={event => {setAuthorized(event.target.checked);changed();}} disabled={!!busy} /><span>{dataClass === "synthetic" ? "这些是测试资料，将明确标记并与真实来源区分。" : "我有权使用这份资料，并同意将原文与压缩截图保存到当前独立工作空间。"}</span></label></div>
      {receipt && <div className="social-receipt"><CheckCircle2 size={22} /><div><strong>{receipt.duplicate ? "已识别为同一份资料" : "资料已保存"}</strong><p>{receipt.linked ? "已关联人工确认的企业；可在已存资料中回看。" : "企业身份待核对；原文与来源已经留存。"}输入仍保留，可继续对照。</p><small>记录编号：{receipt.id}</small></div></div>}
      {clearConfirm && <div className="social-clear-confirm"><p>清空会移除当前输入；已保存的资料不受影响。</p><Button onClick={() => setClearConfirm(false)}>继续核对</Button><Button onClick={clear} variant="primary">确认清空输入</Button></div>}
      <div className="social-save-row"><Button onClick={() => setClearConfirm(true)} disabled={!!busy || (!text && !attachment && !sourceName)}>清空并录入下一条</Button><Button variant="primary" onClick={save} disabled={!!busy || !sourceName.trim() || !text.trim() || text.length > MAX_TEXT || !dataClass || !authorized || (!!companyId && !companyConfirmed) || (!!attachment && !screenshotChecked)} busy={busy === "save"}><Save size={16} />保存来源资料</Button></div>
    </div> : <section className="social-saved"><header><div><h3>来源资料与待关联条目</h3><p>保留渠道、原话和发生时间；关联操作不会认定买家能力或自动发送消息。</p></div><label><input type="checkbox" checked={savedOnlyPending} onChange={event => setSavedOnlyPending(event.target.checked)} />只看待关联</label></header>{visibleSources.length ? <div className="social-source-list">{visibleSources.map(source => <SavedSource key={source.id} source={source} companies={state.companies} busy={busy} onLink={link} />)}</div> : <div className="social-empty"><MessageSquareText size={32} /><strong>{savedOnlyPending ? "当前没有待关联资料" : "还没有保存社媒资料"}</strong><p>资料录入后会显示在这里，不会自动抓取外部账号。</p><Button onClick={() => setTab("capture")}>录入一条资料</Button></div>}</section>}
    <footer className="social-footer"><span>不执行 OCR，不抓取外部账号，不发送消息。</span><Button onClick={close} disabled={!!busy}>完成</Button></footer>
  </div></Modal>;
}

function SavedSource({ source, companies, busy, onLink }: { source: SocialSource; companies: Company[]; busy: string; onLink: (source: SocialSource, companyId: string) => Promise<void> }) {
  const [companyId, setCompanyId] = useState(""); const [confirmed, setConfirmed] = useState(false); const [error, setError] = useState("");
  const company = companies.find(item => item.id === source.companyId);
  const available = companies.filter(item => companyClass(item) === source.dataClass);
  const attach = async () => { if(!companyId || !confirmed || busy)return;setError("");try{await onLink(source,companyId);}catch(cause){setError(cause instanceof Error?cause.message:"关联失败，请重新核对。");} };
  return <article className="social-source"><header><div><span className="social-channel">{source.channel}</span><span className={`social-data-tag ${source.dataClass === "synthetic" ? "synthetic" : ""}`}>{source.dataClass === "synthetic" ? "测试资料" : "真实资料"}</span><h4>{source.sourceName}</h4></div><span className={`social-link-state ${source.companyId ? "linked" : ""}`}>{source.companyId ? "已人工关联" : "企业待核对"}</span></header><div className="social-source-meta"><span>发生：{source.occurredAtPrecision === "date" ? `${source.occurredAtRaw || source.occurredAt?.slice(0, 10) || "未知"}（仅日期）` : source.occurredAt ? formatDate(source.occurredAt, true) : "未知"}</span><span>保存：{formatDate(source.createdAt, true)}</span>{source.handle && <span>原昵称：{source.handle}</span>}{company && <span>关联企业：{company.name}</span>}</div><blockquote>{source.text}</blockquote>{source.sourceUrl && <ExternalLink url={source.sourceUrl}>查看来源链接</ExternalLink>}{source.attachment && <details className="social-stored-image"><summary><ImageIcon size={15} />查看压缩截图 · 未执行 OCR<ChevronDown size={14} /></summary><img src={source.attachment.dataUrl} alt={`${source.sourceName} 的压缩存证副本`} loading="lazy" /><p>{source.attachment.width} × {source.attachment.height} · {bytesLabel(source.attachment.storedBytes)} · 原图哈希：<code>{source.attachment.originalSha256}</code></p></details>}{!source.companyId && <div className="social-link-form"><label><span>确认后关联已有企业</span><select value={companyId} onChange={event => {setCompanyId(event.target.value);setConfirmed(false);setError("");}} disabled={!!busy}><option value="">请选择同类别企业</option>{available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="social-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={!!busy || !companyId} /><span>已核对归属，确认属于所选企业。</span></label><Button onClick={attach} disabled={!!busy || !companyId || !confirmed} busy={busy === `link:${source.id}`}><Link2 size={16} />确认关联</Button>{!available.length && <p>当前没有同类别企业，可以保留待核对，稍后从客户工作台添加企业。</p>}{error && <p className="social-inline-error" role="alert">{error}</p>}</div>}</article>;
}
