import OpenAI from "openai";
import { readRaw, mutatePlatform } from "./store.mjs";
import { currentContext } from "./context.mjs";

const purposes = new Set(["research", "inquiry", "financial", "connection_verification"]);
function problem(code, message, status = 400) { return Object.assign(new Error(message), { code, status, publicError: true }); }
export function modelBudgetDate(at = Date.now()) {
  const time = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(time) ? new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : "";
}
export function budgetFromState(state, at = Date.now()) {
  const date = modelBudgetDate(at);
  // Count the durable, complete server log, never the last-100-row public projection.
  const used = (state.runLog || []).filter(row => row.type === "model_call" && modelBudgetDate(row.startedAt) === date).length;
  return { dailyLimit: null, used, remaining: null, unlimited: true, date, timezone: "Asia/Shanghai", allowedLimits: [] };
}
async function updateUsage(reducer) {
  // Only persistence CAS conflicts can be retried; provider requests are never retried.
  for (let attempt = 0; ; attempt++) {
    try { return await mutatePlatform(reducer); }
    catch (error) { if (error.code !== "WORKSPACE_CONFLICT" || attempt >= 2) throw error; }
  }
}
export async function setModelBudget(dailyLimit) {
  if (!currentContext().authenticated) throw problem("SIGN_IN_REQUIRED", "请先登录，再设置自己账号的模型预算。", 401);
  throw problem("MODEL_BUDGET_UNLIMITED", "本系统已取消模型每日调用次数上限；此接口不再设置数字限额。");
}
export async function reserveModelUsage({ companyId = null, runId, inputHash, requestedModel, configSavedAt = null, purpose = "research", maxOutputTokens = 1800, timeoutMs = 25000, sourceHash, sourceLength }) {
  if (!runId || !inputHash || !requestedModel || !purposes.has(purpose)) throw problem("MODEL_CALL_PARAMETERS", "模型调用参数不完整，尚未发送请求。");
  return updateUsage(state => {
    if (state.runLog.some(row => row.id === runId + "-model")) throw problem("MODEL_CALL_ALREADY_RESERVED", "本次模型调用已记录，未重复发送。", 409);
    state.runLog.push({ id: runId + "-model", companyId, type: "model_call", purpose, status: "in_flight", startedAt: new Date(Math.max(Date.now(), Date.parse(configSavedAt) || 0)).toISOString(),
      provider: "B1X", requestedModel, responseModel: null, model: requestedModel, configSavedAt, inputHash,
      requestId: null, completionId: null, usage: null, durationMs: null, finishedAt: null,
      connectionSucceeded: false, businessValidated: null, requestLimit: 1, maxOutputTokens, timeoutMs,
      ...(sourceHash ? { sourceHash } : {}), ...(Number.isFinite(sourceLength) ? { sourceLength } : {}) });
  });
}
const nonnegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export function modelUsage(usage) {
  return usage && typeof usage === "object" ? { promptTokens: nonnegative(usage.prompt_tokens), completionTokens: nonnegative(usage.completion_tokens), totalTokens: nonnegative(usage.total_tokens) } : null;
}
export function modelCallSummary(row) {
  if (!row) return null;
  const legacyPurpose = row.purpose === "inquiry_extraction" ? "inquiry" : row.purpose === "financial_extraction" ? "financial" : row.purpose;
  return { id: row.id, purpose: purposes.has(legacyPurpose) ? legacyPurpose : "research", provider: "B1X",
    requestedModel: typeof row.requestedModel === "string" ? row.requestedModel : typeof row.model === "string" ? row.model : "",
    responseModel: typeof row.responseModel === "string" ? row.responseModel : null,
    requestId: typeof row.requestId === "string" ? row.requestId : null, completionId: typeof row.completionId === "string" ? row.completionId : null,
    usage: row.usage ? { promptTokens: nonnegative(row.usage.promptTokens), completionTokens: nonnegative(row.usage.completionTokens), totalTokens: nonnegative(row.usage.totalTokens) } : null,
    startedAt: row.startedAt, finishedAt: row.finishedAt || null, durationMs: nonnegative(row.durationMs), status: row.status || "unknown",
    connectionSucceeded: row.connectionSucceeded === true, businessValidated: typeof row.businessValidated === "boolean" ? row.businessValidated : null,
    errorCode: typeof row.errorCode === "string" ? row.errorCode : null, statusCode: typeof row.statusCode === "number" ? row.statusCode : null, configSavedAt: row.configSavedAt || null };
}
export async function modelStatusDetails(configSavedAt) {
  const { state } = await readRaw(), calls = (state.runLog || []).filter(row => row.type === "model_call").sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const successful = calls.filter(row => row.connectionSucceeded === true);
  const verified = configSavedAt && successful.filter(row => row.configSavedAt === configSavedAt && Date.parse(row.startedAt) >= Date.parse(configSavedAt)).at(-1);
  return { budget: budgetFromState(state), currentConfigVerified: !!verified, verifiedAt: verified?.finishedAt || null, lastAttempt: modelCallSummary(calls.at(-1)), lastSuccessfulCall: modelCallSummary(successful.at(-1)) };
}
export async function executeModelCall({ apiKey, baseURL, validate, keepRawResponse = false, ...meta }) {
  if (typeof apiKey !== "string" || apiKey.trim().length < 12 || /\s/.test(apiKey) || !Array.isArray(meta.messages) || !meta.messages.length) throw problem("MODEL_CALL_PARAMETERS", "模型配置或请求参数无效，尚未发送请求。");
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: meta.timeoutMs, fetch: globalThis.fetch });
  const { messages, ...reservation } = meta;
  await reserveModelUsage(reservation);
  const started = performance.now();
  let responseReceived = false, contentPresent = false;
  const patch = values => updateUsage(state => { const row = state.runLog.find(row => row.id === meta.runId + "-model"); if (!row) throw problem("MODEL_LOG_MISSING", "模型调用记录未找到，未重复发送请求。", 409); Object.assign(row, values); });
  try {
    const completion = await client.chat.completions.create({ model: meta.requestedModel, messages, stream: false, max_tokens: meta.maxOutputTokens });
    responseReceived = true;
    const content = completion.choices?.[0]?.message?.content;
    contentPresent = typeof content === "string" && !!content.trim();
    const responseModel = typeof completion.model === "string" ? completion.model : null;
    const requestId = typeof completion._request_id === "string" ? completion._request_id : null;
    const completionId = typeof completion.id === "string" ? completion.id : null, usage = modelUsage(completion.usage);
    await patch({ status: "response_received", responseModel, requestId, completionId, usage, connectionSucceeded: contentPresent, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), ...(keepRawResponse && contentPresent ? { responseContent: content } : {}) });
    if (!contentPresent) throw problem("MODEL_EMPTY", "模型返回内容为空，本次没有生成替代结果。", 502);
    const result = validate ? await validate(content, completion) : undefined;
    const durationMs = Math.round(performance.now() - started);
    const state = await patch({ status: validate ? "validated_pending_review" : "connection_verified", businessValidated: validate ? true : null, durationMs, finishedAt: new Date().toISOString(), ...(Array.isArray(result?.fields) ? { extractedFieldCount: result.fields.length } : {}) });
    return { result, state, responseModel, requestId, completionId, usage, elapsedMs: durationMs };
  } catch (error) {
    const timedOut = error instanceof OpenAI.APIConnectionTimeoutError || error.name === "APIConnectionTimeoutError" || error.name === "AbortError";
    const code = error.publicError ? error.code : timedOut ? "MODEL_TIMEOUT" : error.status === 401 || error.status === 403 ? "MODEL_AUTH_REJECTED" : error.status === 429 ? "MODEL_PROVIDER_RATE_LIMIT" : "MODEL_CALL_FAILED";
    await patch({ status: timedOut ? "outcome_unknown" : "failed", businessValidated: responseReceived && validate ? false : null, connectionSucceeded: contentPresent,
      errorCode: code, statusCode: typeof error.status === "number" ? error.status : null, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started) });
    const failure = error.publicError ? error : problem(code, timedOut ? "B1X 请求超时，结果未知；已记录本次调用，未自动重试。" : "B1X 本次调用未成功，请检查当前配置、服务额度或网络；没有使用固定返回。", timedOut ? 504 : 502);
    failure.includeState = true; throw failure;
  }
}
