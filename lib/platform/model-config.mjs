import { currentContext } from "./context.mjs";
import { createHash, randomUUID } from "node:crypto";
import { executeModelCall, modelStatusDetails, setModelBudget } from "./model-usage.mjs";
export const BASE_URL = "https://token.b1x.work/v1";
export const MODEL = "deepseek-v4.1-flash-1017";
const encoder = new TextEncoder();
function problem(code, message, status = 400) { return Object.assign(new Error(message), { code, status, publicError: true }); }
export function decodeBase64url(value) {
  const base = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base + "=".repeat((4 - base.length % 4) % 4)), c => c.charCodeAt(0));
}
function encodeBase64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
async function encryptionKey(secret) {
  let bytes;
  try { bytes = decodeBase64url(secret || ""); } catch { /* handled below */ }
  if (!bytes || bytes.byteLength !== 32) throw problem("KEY_STORAGE_NOT_READY", "在线密钥存储尚未准备好；客户工作台仍可使用。", 503);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function sealKey(value, secret, ownerId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(ownerId) }, await encryptionKey(secret), encoder.encode(value));
  return { iv: encodeBase64url(iv), ciphertext: encodeBase64url(new Uint8Array(ciphertext)) };
}
export async function unsealKey(sealed, secret, ownerId) {
  try {
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64url(sealed.iv), additionalData: encoder.encode(ownerId) }, await encryptionKey(secret), decodeBase64url(sealed.ciphertext));
    return new TextDecoder().decode(data);
  } catch { throw problem("KEY_CONFIG_UNREADABLE", "保存的模型配置暂时无法读取，请在登录后重新配置。", 503); }
}
export async function modelConfigStatus() {
  const context = currentContext();
  const record = context.authenticated ? await context.db.prepare("SELECT updated_at FROM model_config WHERE owner_id = ?").bind(context.ownerId).first() : null;
  const configSavedAt = record?.updated_at || null;
  return { configured: !!record, authenticated: context.authenticated, storageReady: !!context.dataKey, provider: "B1X", model: MODEL, baseURL: BASE_URL, configSavedAt, ...await modelStatusDetails(configSavedAt) };
}
export async function saveModelKey(key) {
  const context = currentContext();
  if (!context.authenticated) throw problem("SIGN_IN_REQUIRED", "请先登录，再为自己的账号设置模型连接。访客不会使用任何共享 Key。", 401);
  if (typeof key !== "string" || key.trim().length < 12 || key.length > 1024 || /\s/.test(key.trim())) throw problem("INVALID_KEY", "请输入完整的 B1X API Key；不要包含空格或换行。");
  const sealed = await sealKey(key.trim(), context.dataKey, context.ownerId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await context.db.prepare("SELECT updated_at FROM model_config WHERE owner_id = ?").bind(context.ownerId).first();
    const savedAt = new Date(Math.max(Date.now(), (Date.parse(previous?.updated_at) || 0) + 1)).toISOString();
    const result = previous
      ? await context.db.prepare("UPDATE model_config SET ciphertext = ?, iv = ?, updated_at = ? WHERE owner_id = ? AND updated_at = ?").bind(sealed.ciphertext, sealed.iv, savedAt, context.ownerId, previous.updated_at).run()
      : await context.db.prepare("INSERT INTO model_config (owner_id, ciphertext, iv, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id) DO NOTHING").bind(context.ownerId, sealed.ciphertext, sealed.iv, savedAt).run();
    if (result.meta.changes === 1) return modelConfigStatus();
  }
  throw problem("MODEL_CONFIG_CONFLICT", "另一台设备正在更新模型配置，请刷新后再保存；未覆盖较新的配置。", 409);
}
export async function removeModelKey() {
  const context = currentContext();
  if (!context.authenticated) throw problem("SIGN_IN_REQUIRED", "请先登录。", 401);
  await context.db.prepare("DELETE FROM model_config WHERE owner_id = ?").bind(context.ownerId).run();
  return modelConfigStatus();
}
export async function getModelKey() {
  return (await getModelConnection()).apiKey;
}
export async function getModelConnection() {
  const context = currentContext();
  if (!context.authenticated) throw problem("SIGN_IN_REQUIRED", "访客可体验客户工作台；模型分析需要登录并使用自己的 B1X 配置。", 401);
  const record = await context.db.prepare("SELECT ciphertext, iv, updated_at FROM model_config WHERE owner_id = ?").bind(context.ownerId).first();
  if (!record) throw problem("MODEL_NOT_CONFIGURED", "当前账号尚未配置在线 B1X 连接；本机原 .env 不会自动上传到网站。未生成 AI 分析。", 409);
  return { apiKey: await unsealKey(record, context.dataKey, context.ownerId), configSavedAt: record.updated_at };
}
export async function updateModelBudget(dailyLimit) { await setModelBudget(dailyLimit); return modelConfigStatus(); }
export async function verifyModelConnection() {
  const connection = await getModelConnection();
  const messages = [{ role: "user", content: "Reply with OK. This is a connection check; no customer data is included." }];
  await executeModelCall({ ...connection, baseURL: BASE_URL, requestedModel: MODEL, purpose: "connection_verification", runId: randomUUID(), inputHash: createHash("sha256").update(JSON.stringify(messages)).digest("hex"), messages, maxOutputTokens: 32, timeoutMs: 15000 });
  return modelConfigStatus();
}
