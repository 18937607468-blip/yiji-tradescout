import { createHash, randomUUID } from "node:crypto";
import { mutatePlatform } from "./store.mjs";

export const SOCIAL_CAPTURE_LIMITS = { maxTextLength: 16000, maxAttachmentBytes: 200 * 1024, maxOriginalBytes: 10 * 1024 * 1024, maxAttachments: 1 };
export const SOCIAL_CHANNELS = ["视频号", "微信", "Facebook", "WhatsApp", "MIC", "其他"];
function fail(code, message, status = 400) { throw Object.assign(new Error(message), { code, status, publicError: true }); }
const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
function field(value, label, limit, required = false) {
  if (value !== undefined && value !== null && typeof value !== "string") fail("INVALID_FIELDS", label + " 必须是文本。");
  const clean = (value || "").trim();
  if (clean.length > limit || (required && !clean)) fail("INVALID_FIELDS", label + " 缺失或超出长度上限。");
  return clean;
}
function cleanUrl(value) {
  const raw = field(value, "原始来源链接", 2048);
  if (!raw) return "";
  try { const parsed = new URL(raw); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); return parsed.href; }
  catch { fail("INVALID_SOURCE_URL", "来源链接需是有效 HTTP(S) 地址；没有公开链接可留空并注明来源。"); }
}
function sourceTime(value) {
  const raw = field(value, "原文发生时间", 80);
  if (!raw) return { occurredAt: "", occurredAtRaw: "", occurredAtPrecision: "unknown" };
  const calendar = raw.slice(0, 10), calendarDate = new Date(calendar);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(calendar) || !Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== calendar) fail("INVALID_SOURCE_DATE", "来源日期不存在，未把无效日期自动滚动到下个月。");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) fail("INVALID_SOURCE_DATE", "来源日期无效；不知道具体时间可只填日期或留空。");
    return { occurredAt: raw, occurredAtRaw: raw, occurredAtPrecision: "date" };
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) || !Number.isFinite(Date.parse(raw))) fail("INVALID_SOURCE_DATE", "具体发生时间需包含时区；未知时请留空，系统不会用录入时间冒充沟通时间。");
  return { occurredAt: new Date(raw).toISOString(), occurredAtRaw: raw, occurredAtPrecision: "datetime" };
}
function validateAttachment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_ATTACHMENT", "每条只接受一张压缩截图附件。");
  if (value.compressed !== true) fail("ATTACHMENT_NOT_COMPRESSED", "请先在浏览器压缩截图；本功能只保存压缩副本。");
  const mime = field(value.mime, "图片格式", 40, true);
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) fail("ATTACHMENT_TYPE", "截图仅支持 PNG、JPEG 或 WebP；不接受 SVG 或外链。");
  if (typeof value.dataUrl !== "string" || value.dataUrl.length > Math.ceil(SOCIAL_CAPTURE_LIMITS.maxAttachmentBytes / 3) * 4 + 100) fail("ATTACHMENT_TOO_LARGE", "压缩截图最多 200 KiB（204800 字节）。", 413);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.dataUrl);
  if (!match || match[1] !== mime || match[2].length % 4) fail("INVALID_ATTACHMENT", "图片必须是格式一致的内嵌 base64 数据，不会访问外部图片链接。");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.toString("base64") !== match[2] || bytes.length > SOCIAL_CAPTURE_LIMITS.maxAttachmentBytes) fail("ATTACHMENT_TOO_LARGE", "图片编码无效或超过 200 KiB 压缩副本上限。", 413);
  const png = bytes.length >= 24 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" && bytes.subarray(12, 16).toString("ascii") === "IHDR";
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  const webp = bytes.length >= 20 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (!({ "image/png": png, "image/jpeg": jpeg, "image/webp": webp })[mime]) fail("ATTACHMENT_SIGNATURE", "截图内容与声明格式不一致，未保存。");
  for (const key of ["width", "height"]) if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 8192) fail("INVALID_IMAGE_SIZE", "截图宽高需为有效像素尺寸。");
  if (png && (bytes.readUInt32BE(16) !== value.width || bytes.readUInt32BE(20) !== value.height)) fail("INVALID_IMAGE_SIZE", "PNG 文件尺寸与提交的截图尺寸不一致。");
  if (!Number.isInteger(value.storedBytes) || value.storedBytes !== bytes.length) fail("INVALID_ATTACHMENT_SIZE", "压缩附件的字节数与实际内容不一致。");
  if (!Number.isInteger(value.originalSize) || value.originalSize < 1 || value.originalSize > SOCIAL_CAPTURE_LIMITS.maxOriginalBytes) fail("ORIGINAL_IMAGE_SIZE", "原图需为 10 MiB 以内文件；这里只保存压缩副本。");
  const originalSha256 = field(value.originalSha256, "原文件摘要", 64, true).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(originalSha256)) fail("INVALID_ORIGINAL_HASH", "原文件 SHA-256 摘要格式无效。");
  return { dataUrl: value.dataUrl, fileName: field(value.fileName, "截图文件名", 200, true), mime, originalSha256, originalSize: value.originalSize,
    width: value.width, height: value.height, storedBytes: bytes.length, compressed: true, storedSha256: hash(bytes), originalHashVerification: "client_reported" };
}
function classFor(company) { return company.dataClass === "synthetic" || company.isDemo === true ? "synthetic" : "real"; }
function companyFor(state, companyId, dataClass) {
  const company = state.companies.find(c => c.id === companyId);
  if (!company) fail("COMPANY_NOT_FOUND", "当前私有工作区没有该企业，请手动选择已有企业。", 404);
  if (classFor(company) !== dataClass) fail("DATA_CLASS_MISMATCH", "真实资料和演示企业不能混合关联，请选择相同资料类型的企业。");
  return company;
}
function addEvent(state, source, type, title, now) {
  state.events.push({ id: randomUUID(), companyId: source.companyId || null, type, title, createdAt: now, socialSourceId: source.id,
    summary: source.channel + " · " + source.sourceName + "；人工保存原文，未调用 OCR、同步、发送或自动更新客户画像。", dataClass: source.dataClass });
}
function linkSource(state, source, companyId, payload, now) {
  if (payload.companyConfirmed !== true) fail("COMPANY_CONFIRMATION_REQUIRED", "请人工确认该社媒身份与所选企业的关系；昵称不会自动匹配公司。");
  const company = companyFor(state, companyId, source.dataClass);
  if (source.companyId && source.companyId !== companyId) fail("SOURCE_ALREADY_LINKED", "这条资料已关联另一企业；为保留责任链，不能自动改绑。", 409);
  if (source.companyId === companyId) return false;
  source.companyId = companyId; source.companyConfirmed = true; source.status = "linked"; source.revision += 1; source.updatedAt = now;
  source.history.push({ id: randomUUID(), action: "linked", at: now, companyId, companyName: company.name, method: "manual_confirmation" });
  company.communications ||= []; company.evidence ||= [];
  if (!company.communications.some(c => c.socialSourceId === source.id)) {
    company.communications.push({ id: randomUUID(), text: source.text, occurredAt: source.occurredAt, recordedAt: now, contentHash: hash(companyId + "\n" + source.id),
      dataClass: source.dataClass, socialSourceId: source.id, channel: source.channel, handle: source.handle, sourceName: source.sourceName, sourceUrl: source.sourceUrl, captureMethod: source.captureMethod });
  }
  if (!company.evidence.some(e => e.socialSourceId === source.id)) {
    company.evidence.push({ id: randomUUID(), type: source.captureMethod === "screenshot" ? "document" : "manual", title: source.channel + " 授权资料 · " + source.sourceName,
      snippet: source.text, url: source.sourceUrl || undefined, capturedAt: now, occurredAt: source.occurredAt || undefined, status: "reported", socialSourceId: source.id,
      dataClass: source.dataClass, channel: source.channel, sourceKind: "authorized_social_capture", attachmentSourceId: source.attachment ? source.id : undefined, ocrPerformed: false });
  }
  company.revision = (company.revision || 0) + 1; company.updatedAt = now;
  addEvent(state, source, "social_source_linked", "人工关联社媒原始资料", now);
  return true;
}
function validateSave(payload) {
  const channel = field(payload.channel, "渠道", 40, true);
  if (!SOCIAL_CHANNELS.includes(channel)) fail("INVALID_SOCIAL_CHANNEL", "请选择支持的社媒或业务渠道。");
  if (!["paste", "text_file", "screenshot"].includes(payload.captureMethod)) fail("INVALID_CAPTURE_METHOD", "请选择粘贴文字、文本文件或截图人工录字。");
  if (!["real", "synthetic"].includes(payload.dataClass)) fail("DATA_CLASS_REQUIRED", "请明确区分真实资料和演示样例。");
  if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > SOCIAL_CAPTURE_LIMITS.maxTextLength) fail("SOCIAL_TEXT_REQUIRED", "请填写 16000 字符以内原文；截图需要人工录字校对，没有自动 OCR。");
  if (payload.captureMethod === "screenshot" && !payload.attachment) fail("SCREENSHOT_REQUIRED", "截图录入需同时保存一张压缩副本及人工校对文字。");
  if (payload.captureMethod !== "screenshot" && payload.attachment != null) fail("INVALID_ATTACHMENT", "图片附件只用于截图人工录字模式。");
  const source = { channel, handle: field(payload.handle, "昵称或账号", 160), captureMethod: payload.captureMethod, sourceName: field(payload.sourceName, "来源名称", 200, true),
    sourceUrl: cleanUrl(payload.sourceUrl), ...sourceTime(payload.occurredAt), text: payload.text, authorized: true, dataClass: payload.dataClass };
  if (payload.attachment) source.attachment = validateAttachment(payload.attachment);
  source.contentHash = hash({ channel: source.channel, handle: source.handle, sourceName: source.sourceName, sourceUrl: source.sourceUrl, occurredAt: source.occurredAt,
    text: source.text.replace(/\r\n?/g, "\n"), dataClass: source.dataClass, storedSha256: source.attachment?.storedSha256 || "" });
  return source;
}
export async function captureSocialSource(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("INVALID_FIELDS", "社媒录入请求格式无效。");
  if (payload.authorized !== true) fail("SOCIAL_AUTH_REQUIRED", "请确认有权保存和使用这份社媒资料。");
  if (!["save", "link"].includes(payload.mode)) fail("SOCIAL_MODE_REQUIRED", "请选择保存资料或人工关联企业。");
  const input = payload.mode === "save" ? validateSave(payload) : null;
  const meta = { id: "", duplicate: false, linked: false, companyId: "", revision: 0, notice: "仅保存授权原文和人工关联；没有 OCR、社媒同步、外发消息或自动企业识别。" };
  const state = await mutatePlatform(next => {
    next.socialSources ||= [];
    const now = new Date().toISOString(), companyId = field(payload.companyId, "关联企业", 100, payload.mode === "link");
    let source;
    if (payload.mode === "save") {
      source = next.socialSources.find(item => item.contentHash === input.contentHash);
      if (source) meta.duplicate = true;
      else {
        source = { ...input, id: randomUUID(), revision: 1, companyId: "", companyConfirmed: false, status: "pending_company", ocrPerformed: false, synced: false, createdAt: now, updatedAt: now,
          history: [{ id: randomUUID(), action: "saved", at: now, companyId: "", method: "authorized_manual_capture" }] };
        next.socialSources.push(source);
        addEvent(next, source, "social_source_saved", "保存授权社媒原始资料", now);
      }
    } else {
      const id = field(payload.id, "资料编号", 100, true);
      source = next.socialSources.find(item => item.id === id);
      if (!source) fail("SOCIAL_SOURCE_NOT_FOUND", "当前私有工作区没有这条社媒资料。", 404);
      if (source.companyId === companyId) meta.duplicate = true;
      else if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision !== source.revision) fail("REVISION_CONFLICT", "资料关联状态已改变，请刷新后重新核对。", 409);
    }
    if (companyId) linkSource(next, source, companyId, payload, now);
    Object.assign(meta, { id: source.id, linked: !!source.companyId, companyId: source.companyId, revision: source.revision });
  });
  return { state, meta };
}
