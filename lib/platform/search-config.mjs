import { randomUUID } from "node:crypto";
import { currentContext } from "./context.mjs";
import { sealKey, unsealKey } from "./model-config.mjs";

function problem(code, message, status = 400) { return Object.assign(new Error(message), { code, status, publicError: true }); }
const aad = ownerId => "tavily-search:" + ownerId;
const verificationQuery = "commercial vehicle brake lining distributor";
function authenticatedContext() {
  const context = currentContext();
  if (!context.authenticated) throw problem("SIGN_IN_REQUIRED", "请先登录，再设置和验证自己账号的 Tavily 搜索 Key。", 401);
  return context;
}
function verificationFromRecord(value, configSavedAt) {
  let record; try { record = JSON.parse(value || "null"); } catch { return null; }
  if (!record || !["succeeded", "failed"].includes(record.status) || record.configSavedAt !== configSavedAt || !Number.isFinite(Date.parse(record.checkedAt))) return null;
  const result = { status: record.status, checkedAt: record.checkedAt, configSavedAt };
  for (const field of ["httpStatus", "resultCount", "credits", "retryAfterSeconds"]) if (typeof record[field] === "number" && Number.isFinite(record[field]) && record[field] >= 0) result[field] = record[field];
  for (const field of ["requestId", "errorCode", "message"]) if (typeof record[field] === "string") result[field] = record[field].slice(0, field === "message" ? 500 : 160);
  return result;
}
export async function searchConfigStatus() {
  const context = currentContext();
  const record = context.authenticated ? await context.db.prepare("SELECT updated_at, last_verification FROM search_config WHERE owner_id = ?").bind(context.ownerId).first() : null;
  const configSavedAt = record?.updated_at || null;
  return { authenticated: context.authenticated, configured: !!record, storageReady: !!context.dataKey, provider: "Tavily", authMode: record ? "keyed" : "unconfigured", configSavedAt, lastVerification: verificationFromRecord(record?.last_verification, configSavedAt) };
}
export async function saveSearchKey(key) {
  const context = authenticatedContext();
  if (typeof key !== "string" || key.trim().length < 12 || key.length > 1024 || !/^tvly-[A-Za-z0-9_-]+$/.test(key.trim())) throw problem("SEARCH_INVALID_KEY", "请输入以 tvly- 开头的完整 Tavily API Key；B1X 赛事模型 Key 不能用于搜索。");
  const sealed = await sealKey(key.trim(), context.dataKey, aad(context.ownerId));
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await context.db.prepare("SELECT updated_at FROM search_config WHERE owner_id = ?").bind(context.ownerId).first();
    const savedAt = new Date(Math.max(Date.now(), (Date.parse(previous?.updated_at) || 0) + 1)).toISOString();
    const result = previous
      ? await context.db.prepare("UPDATE search_config SET ciphertext = ?, iv = ?, updated_at = ?, last_verification = NULL, verification_id = NULL, verification_started_at = NULL WHERE owner_id = ? AND updated_at = ?").bind(sealed.ciphertext, sealed.iv, savedAt, context.ownerId, previous.updated_at).run()
      : await context.db.prepare("INSERT INTO search_config (owner_id, ciphertext, iv, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id) DO NOTHING").bind(context.ownerId, sealed.ciphertext, sealed.iv, savedAt).run();
    if (result.meta.changes === 1) return searchConfigStatus();
  }
  throw problem("SEARCH_CONFIG_CONFLICT", "另一台设备正在更新搜索配置，请刷新后再保存；未覆盖新配置。", 409);
}
export async function getSearchConnection() {
  const context = currentContext();
  if (!context.authenticated) throw problem("SEARCH_NOT_CONFIGURED", "请先登录并配置独立的 Tavily 搜索 Key；可使用手工官网或 CSV 导入，不会使用共享或免 Key 搜索。", 409);
  const record = await context.db.prepare("SELECT ciphertext, iv, updated_at FROM search_config WHERE owner_id = ?").bind(context.ownerId).first();
  if (!record) throw problem("SEARCH_NOT_CONFIGURED", "当前账号尚未配置独立 Tavily 搜索 Key；已保留输入，可手工提供官网继续核验。", 409);
  let apiKey;
  try { apiKey = await unsealKey(record, context.dataKey, aad(context.ownerId)); }
  catch { throw problem("SEARCH_CONFIG_UNREADABLE", "保存的 Tavily 配置暂时无法读取，请重新保存；未自动退回免费搜索。", 503); }
  return { apiKey, authMode: "keyed", configSavedAt: record.updated_at };
}
export async function verifySearchConnection() {
  const context = authenticatedContext(), connection = await getSearchConnection();
  if (!connection.apiKey) throw problem("SEARCH_NOT_CONFIGURED", "请先保存自己账号的 Tavily Key。此按钮不会将免费搜索试用当作账号 Key 验证。", 409);
  const verificationId = randomUUID(), startedAt = new Date().toISOString(), cutoff = new Date(Date.now() - 30000).toISOString();
  const reserved = await context.db.prepare("UPDATE search_config SET verification_id = ?, verification_started_at = ? WHERE owner_id = ? AND updated_at = ? AND (verification_id IS NULL OR verification_started_at < ?)").bind(verificationId, startedAt, context.ownerId, connection.configSavedAt, cutoff).run();
  if (reserved.meta.changes !== 1) throw problem("SEARCH_VERIFICATION_BUSY", "搜索配置已变化或正在另一台设备验证，请刷新后再试；未重复发送。", 409);
  const { searchPublicCandidates, searchFailureMetadata } = await import("./buyer-discovery.mjs");
  let result, failure;
  try { result = await searchPublicCandidates(verificationQuery, { apiKey: connection.apiKey, maxResults: 3 }); }
  catch (error) { failure = error; }
  const details = result || searchFailureMetadata(failure);
  const verification = { status: failure ? "failed" : "succeeded", checkedAt: new Date().toISOString(), configSavedAt: connection.configSavedAt };
  for (const field of ["httpStatus", "requestId", "retryAfterSeconds"]) if (details[field] !== undefined) verification[field] = details[field];
  if (failure) {
    verification.errorCode = failure.publicError ? failure.code : "SEARCH_VERIFICATION_FAILED";
    verification.message = failure.publicError ? failure.message : "搜索验证未完成，没有使用替代结果。";
  } else {
    verification.resultCount = result.results.length;
    if (typeof result.usage?.credits === "number" && Number.isFinite(result.usage.credits) && result.usage.credits >= 0) verification.credits = result.usage.credits;
  }
  const saved = await context.db.prepare("UPDATE search_config SET last_verification = ?, verification_id = NULL, verification_started_at = NULL WHERE owner_id = ? AND updated_at = ? AND verification_id = ?").bind(JSON.stringify(verification), context.ownerId, connection.configSavedAt, verificationId).run();
  if (saved.meta.changes !== 1) throw problem("SEARCH_CONFIG_CHANGED", "验证期间搜索 Key 已更新；旧 Key 的结果未记为当前配置成功。", 409);
  if (failure) throw failure.publicError ? failure : problem("SEARCH_VERIFICATION_FAILED", "搜索验证未完成，没有使用替代结果。", 502);
  return searchConfigStatus();
}
