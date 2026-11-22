"use client";

import { FormEvent, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, Cloud, KeyRound, LogIn, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { ModelCallSummary, ModelConnectionStatus, PlatformState } from "./types";
import { Button } from "./PlatformUI";
import "./HostedAccess.css";

export function HostedAccessBar({ identity, loaded, signInHref, signOutHref }: {
  identity: PlatformState["identity"]; loaded: boolean; signInHref: string; signOutHref: string;
}) {
  const authenticated = identity?.authenticated;
  return <section className="ts-access-bar" aria-label="当前访问空间">
    <span className="ts-access-icon">{authenticated ? <Cloud size={20} /> : <UserRound size={20} />}</span>
    <div><strong>{!loaded ? "正在确认访问空间" : authenticated ? `账号空间${identity?.displayName ? ` · ${identity.displayName}` : ""}` : "匿名体验空间"}</strong><p>{!loaded ? "连接在线服务后显示数据范围。" : authenticated ? "同一 ChatGPT 账号登录后，手机与电脑可同步查看这份记录。" : "当前浏览器拥有独立记录。登录后使用账号空间，支持同账号跨设备同步。"}</p></div>
    {loaded && (authenticated ? <a className="ts-access-link" href={signOutHref} target="_top">退出账号</a> : <a className="ts-button ts-button-secondary" href={signInHref} target="_top"><LogIn size={16} />登录后跨设备同步</a>)}
  </section>;
}

export function HostedModelConfig({ identity, capabilities, connection, connectionLoading, connectionError, signInHref, onSave, onVerify, onRefresh, busy }: {
  identity: PlatformState["identity"]; capabilities: PlatformState["capabilities"]; signInHref: string;
  connection: ModelConnectionStatus | null; connectionLoading: boolean; connectionError: string;
  onSave: (key: string) => Promise<ModelConnectionStatus>;
  onVerify: () => Promise<ModelConnectionStatus>; onRefresh: () => Promise<unknown>; busy: string;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const budget = connection?.budget;
  const configured = connection?.configured ?? capabilities.modelConfigured;
  const verified = !!connection?.currentConfigVerified;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return;
    const submittedKey = key.trim(); setError(""); setResult("");
    if (!submittedKey) { setError("请填写要保存在当前账号服务端配置中的 B1X API Key。"); return; }
    setKey("");
    try { await onSave(submittedKey); setResult("配置已保存。本次只保存 Key，没有发起模型验证。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "配置未保存，请重新输入后重试。"); }
  };
  const verify = async () => {
    if (busy || key.trim() || !connection || !configured || connection.lastAttempt?.status === "in_flight") return;
    setError(""); setResult("");
    try { await onVerify(); setResult("连接验证已完成，已发起 1 次真实调用。实际模型、Token 和请求记录见下方。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "验证未完成，请查看最新调用记录。"); }
  };
  return <section className="ts-panel ts-settings-panel ts-hosted-model"><h2><KeyRound size={19} />账号模型配置</h2>
    <div className={`ts-model-state ${verified ? "is-verified" : ""}`}><span>{verified ? <CheckCircle2 size={20} /> : <KeyRound size={20} />}</span><div><strong>{connection ? !configured ? "尚未保存模型配置" : verified ? "当前配置有成功调用记录" : "配置已保存 · 尚未验证" : connectionLoading ? "正在读取模型状态" : "模型状态待刷新"}</strong><p>{verified ? `最近验证于 ${beijingTime(connection?.verifiedAt)}` : "保存 Key 与验证连接是两个独立操作。"}</p></div><Button variant="quiet" onClick={onRefresh} busy={connectionLoading} disabled={!!busy || connectionLoading} aria-label="刷新模型状态"><RefreshCw size={16} /></Button></div>
    <div className="ts-model-requested"><span>服务 · {connection?.provider || "等待读取"}</span><span>请求模型 <code>{connection?.model || "等待读取"}</code></span><span>推理档位：未单独指定，使用服务默认。</span></div>
    {connectionError && <p className="ts-model-status-error" role="alert"><AlertCircle size={15} />{connectionError}</p>}
    {!identity?.authenticated ? <div className="ts-hosted-login"><p>请先登录 ChatGPT，再为自己的账号配置模型。匿名体验仍可管理客户、导入资料和安排跟进。</p><a className="ts-button ts-button-primary" href={signInHref} target="_top"><LogIn size={16} />登录并配置模型</a></div> : capabilities.modelKeyStorageAvailable === false ? <div className="ts-info-box"><ShieldCheck size={18} /><p>当前服务的密钥安全存储尚未就绪，暂不能提交配置。已有客户记录与人工核验功能仍可使用。</p></div> : <form onSubmit={submit} className="ts-model-form">
      <label className="ts-field">B1X API Key<input type="password" name="b1xApiKey" value={key} onChange={event => { setKey(event.target.value); setResult(""); }} autoComplete="new-password" autoCapitalize="none" spellCheck={false} placeholder={configured ? "输入新的 Key 可更新当前账号配置" : "输入已有的 B1X API Key"} disabled={!!busy} required /></label>
      <p className="ts-form-note">只保存在当前账号的服务端。提交后清空输入；保存不会消耗模型调用。</p>
      <div className="ts-model-actions"><Button type="submit" variant="primary" busy={busy === "model-config"} disabled={!!busy || !key.trim()}>保存配置</Button><Button type="button" onClick={verify} busy={busy === "model-verify"} disabled={!!busy || !connection || !configured || !!key.trim() || connection?.lastAttempt?.status === "in_flight"}><ShieldCheck size={16} />验证连接 · 发起 1 次调用</Button></div>
      {key.trim() && <p className="ts-model-help">请先保存新 Key，再验证保存后的配置。</p>}
    </form>}
    <section className="ts-model-usage"><div className="ts-model-usage-title"><h3><Clock3 size={16} />今日模型调用</h3><span>{budget?.date || "等待读取"} · 北京时间</span></div><div className="ts-model-usage-count"><strong>{budget ? budget.used : "—"}</strong><span>次已发起请求</span></div>
      <p>{budget?.unlimited ? "本系统不设每日调用次数上限。" : "调用记录读取后显示当前规则。"}</p><p>实际可用额度由 B1X 账户决定。公开搜索与规则初筛不计入模型调用。</p>
    </section>
    {connection?.lastAttempt && <details className="ts-model-attempt"><summary><Clock3 size={16} />最近一次模型请求<span>{modelCallStatus(connection.lastAttempt.status)}</span></summary><ModelCallDetails call={connection.lastAttempt} /></details>}
    {connection?.lastSuccessfulCall && connection.lastSuccessfulCall.id !== connection.lastAttempt?.id && <details className="ts-model-attempt"><summary><CheckCircle2 size={16} />最近成功调用<span>{connection.lastSuccessfulCall.configSavedAt !== connection.configSavedAt ? "历史配置 · " : ""}{beijingTime(connection.lastSuccessfulCall.startedAt)}</span></summary><ModelCallDetails call={connection.lastSuccessfulCall} /></details>}
    {error && <p className="ts-inline-error" role="alert">{error}</p>}{result && <p className="ts-customs-status" role="status">{result}</p>}
  </section>;
}

export function modelCallStatus(status?: string) {
  return ({ in_flight: "请求进行中", response_received: "服务已响应", validated: "业务输出已校验", validated_pending_review: "已提取 · 待人工确认", connection_verified: "连接验证成功", verified: "连接验证成功", failed: "请求失败", outcome_unknown: "结果待确认", blocked: "调用未运行" } as Record<string,string>)[status || ""] || status || "状态未记录";
}

function beijingTime(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "未记录时间";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

export function ModelCallDetails({ call }: { call: Partial<ModelCallSummary> }) {
  const text = (value: unknown, fallback = "服务未返回") => typeof value === "string" && value.trim() ? value : fallback;
  const token = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value.toLocaleString() : "服务未返回";
  const purpose = ({ research: "客户官网研究", inquiry: "询价原文提取", financial: "财报字段提取", connection_verification: "连接验证" } as Record<string,string>)[call.purpose || ""] || text(call.purpose, "未记录用途");
  const duration = typeof call.durationMs === "number" && Number.isFinite(call.durationMs) && call.durationMs >= 0 ? call.durationMs >= 1000 ? `${(call.durationMs / 1000).toFixed(2)} 秒` : `${call.durationMs} 毫秒` : "未记录";
  return <div className="ts-model-call-details"><dl className="ts-model-call-grid"><div><dt>调用用途</dt><dd>{purpose}</dd></div><div><dt>提供方</dt><dd>{text(call.provider, "未记录")}</dd></div><div><dt>请求模型</dt><dd><code>{text(call.requestedModel, "旧记录未保存")}</code></dd></div><div><dt>实际返回模型</dt><dd><code>{text(call.responseModel)}</code></dd></div><div><dt>调用状态</dt><dd>{modelCallStatus(call.status)}</dd></div><div><dt>耗时</dt><dd>{duration}</dd></div><div><dt>连接响应</dt><dd>{call.connectionSucceeded === true ? "服务已成功返回" : call.connectionSucceeded === false ? call.status === "in_flight" ? "等待返回" : "未成功返回" : "旧记录未保存"}</dd></div><div><dt>业务输出校验</dt><dd>{call.purpose === "connection_verification" ? "连接验证不产生业务结论" : call.businessValidated === true ? "已通过校验" : call.businessValidated === false ? "未通过校验" : "未完成或未记录"}</dd></div></dl>
    <div className="ts-model-token-grid"><div><span>输入 Token</span><strong>{token(call.usage?.promptTokens)}</strong></div><div><span>输出 Token</span><strong>{token(call.usage?.completionTokens)}</strong></div><div><span>总 Token</span><strong>{token(call.usage?.totalTokens)}</strong></div></div>
    <dl className="ts-model-call-ids"><div><dt>请求 ID</dt><dd><code>{text(call.requestId)}</code></dd></div><div><dt>响应 ID</dt><dd><code>{text(call.completionId)}</code></dd></div><div><dt>开始时间</dt><dd>{beijingTime(call.startedAt)} · 北京时间</dd></div>{call.errorCode && <div><dt>错误</dt><dd>{call.errorCode}{typeof call.statusCode === "number" ? ` · HTTP ${call.statusCode}` : ""}</dd></div>}</dl>
  </div>;
}
