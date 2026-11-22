"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, KeyRound, LogIn, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Button } from "./PlatformUI";
import type { SearchConfigStatus } from "./search-config-types";
import "./SearchConfigPanel.css";

type ApiResponse = { ok?: boolean; data?: SearchConfigStatus; error?: { message?: string } };
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value.toLocaleString() : "服务未返回";
const beijingTime = (value?: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value))
  : "未记录时间";

export default function SearchConfigPanel({ signInHref, disabled = false }: { signInHref: string; disabled?: boolean }) {
  const [status, setStatus] = useState<SearchConfigStatus | null>(null);
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "verify" | "">("");
  const [statusError, setStatusError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);

  const request = useCallback(async (payload?: Record<string, unknown>): Promise<SearchConfigStatus> => {
    const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), payload?.mode === "verify_connection" ? 40000 : 15000);
    try {
      const response = await fetch("/api/platform/search-config", payload ? {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: abort.signal,
      } : { cache: "no-store", signal: abort.signal });
      let body: ApiResponse;
      try { body = await response.json(); } catch { throw new Error(`搜索配置服务返回了无法读取的响应（${response.status}）。请刷新后核对。`); }
      if (!response.ok || !body.ok || !body.data || body.data.provider !== "Tavily") throw new Error(body.error?.message || `搜索配置操作未完成（${response.status}）。`);
      return body.data;
    } catch (cause) {
      throw new Error(cause instanceof Error && cause.name === "AbortError" ? "请求等待超时，结果暂不确定。请刷新状态后核对，不要连续重复验证。" : cause instanceof Error ? cause.message : "搜索配置操作未完成。");
    } finally { clearTimeout(timeout); }
  }, []);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true); setStatusError("");
    try {
      const data = await request();
      if (mounted.current && version === requestVersion.current) setStatus(data);
    } catch (cause) {
      if (mounted.current && version === requestVersion.current) setStatusError(cause instanceof Error ? cause.message : "搜索状态暂未读取成功。");
    } finally { if (mounted.current && version === requestVersion.current) setLoading(false); }
  }, [request]);

  useEffect(() => {
    mounted.current = true; void refresh();
    return () => { mounted.current = false; requestVersion.current++; controller.current?.abort(); };
  }, [refresh]);

  const last = status?.lastVerification;
  const currentVerification = !!status?.configured && !!status.configSavedAt && last?.configSavedAt === status.configSavedAt;
  const verified = status?.authMode === "keyed" && currentVerification && last?.status === "succeeded";
  const locked = disabled || !!busy || loading;
  const canConfigure = !!status?.authenticated && !!status.storageReady && !statusError;

  const mutate = async (operation: "save" | "verify", payload: Record<string, unknown>) => {
    setBusy(operation); setError(""); setNotice(""); requestVersion.current++;
    try {
      const data = await request(payload);
      if (!mounted.current) return;
      setStatus(data); setStatusError("");
      if (operation === "save") setNotice("Tavily Key 已保存。尚未发起搜索，也不代表验证成功。");
      else if (data.configSavedAt && data.lastVerification?.configSavedAt === data.configSavedAt && data.lastVerification.status === "succeeded") setNotice("本次真实搜索已成功返回。结果数量与请求记录见下方。");
      else setError(data.lastVerification?.message || "本次未取得当前 Key 的成功验证，请查看最新请求记录。");
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : "操作未完成，请核对状态。");
      await refresh();
    } finally { if (mounted.current) setBusy(""); }
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (locked || !canConfigure || !key.trim()) return;
    const submittedKey = key.trim(); setKey("");
    await mutate("save", { mode: "save", key: submittedKey });
  };
  const verify = async () => {
    if (locked || !canConfigure || !status?.configured || key.trim()) return;
    await mutate("verify", { mode: "verify_connection" });
  };

  const heading = !status ? loading ? "正在读取搜索状态" : "搜索状态待刷新"
    : !status.configured ? "尚未配置独立 Key · 可手工导入"
    : verified ? "当前 Key 已通过真实搜索验证"
    : currentVerification && last?.status === "failed" ? "当前 Key 验证未成功" : "独立 Key 已保存 · 尚未验证";

  return <section id="ts-search-config" className="ts-panel ts-settings-panel ts-span-2 sc-panel" aria-label="自动搜索连接">
    <div className="sc-heading"><div><h2><Search size={19} />自动搜索连接</h2><p>Tavily 提供网页搜索；赛事 B1X 继续用于客户研究，两种 Key 分开配置。</p></div><Button variant="quiet" onClick={() => void refresh()} busy={loading} disabled={locked} aria-label="刷新自动搜索状态"><RefreshCw size={16} /></Button></div>
    <div className={`sc-state ${verified ? "is-verified" : ""}`}><span>{verified ? <CheckCircle2 size={19} /> : <KeyRound size={19} />}</span><div><strong>{heading}</strong><p>{status?.configSavedAt ? `当前配置保存于 ${beijingTime(status.configSavedAt)} · 北京时间` : "未配置不会调用搜索服务；可保留条件，手工提供官网继续核验。"}</p></div></div>
    {statusError && <p className="sc-error" role="alert"><AlertCircle size={16} />{statusError}</p>}
    <div className="sc-content">
      <div>
        {status && !status.authenticated ? <div className="sc-login"><p>请先登录当前 ChatGPT 账号，再保存自己的 Tavily 搜索 Key。</p><a className="ts-button ts-button-primary" href={signInHref} target="_top"><LogIn size={16} />登录并配置搜索</a></div>
          : status?.authenticated && !status.storageReady ? <p className="sc-error"><ShieldCheck size={16} />当前密钥安全存储尚未就绪，暂不能提交配置。</p>
          : status?.authenticated && <form onSubmit={save} className="sc-form"><label className="ts-field">Tavily API Key<input type="password" name="tavilyApiKey" value={key} onChange={event => { setKey(event.target.value); setNotice(""); }} autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={4096} placeholder={status.configured ? "输入新 Key 可更新当前账号配置" : "输入自己的 Tavily Key，不要填写 B1X Key"} disabled={locked || !canConfigure} required /></label><p>仅提交到当前账号的服务端配置；输入提交后清空，不在浏览器持久保存。</p><div className="sc-actions"><Button type="submit" variant="primary" busy={busy === "save"} disabled={locked || !canConfigure || !key.trim()}>保存搜索 Key</Button><Button type="button" onClick={verify} busy={busy === "verify"} disabled={locked || !canConfigure || !status.configured || !!key.trim()}><ShieldCheck size={16} />验证真实搜索 · 1 次</Button></div><p>{key.trim() ? "请先保存输入的新 Key，再验证当前已保存配置。" : "验证会发起 1 次 Tavily 搜索并消耗提供方额度。保存和刷新状态不会发起搜索。"}</p></form>}
        <div className="sc-links"><a href="https://app.tavily.com" target="_blank" rel="noopener noreferrer">获取 Tavily Key<ExternalLink size={13} /></a></div>
      </div>
      <div className="sc-verification"><h3>最近一次真实验证 <span>{last ? currentVerification ? "当前配置" : "历史配置" : "尚无记录"}</span></h3>{last ? <><div className={`sc-verification-status ${last.status === "failed" ? "is-failed" : ""}`}><strong>{last.status === "succeeded" ? "搜索已返回" : "验证未完成"}</strong><time>{beijingTime(last.checkedAt)} · 北京时间</time></div><dl><div><dt>返回结果</dt><dd>{numeric(last.resultCount)}{typeof last.resultCount === "number" ? " 条" : ""}</dd></div><div><dt>提供方 Credits</dt><dd>{numeric(last.credits)}</dd></div><div><dt>HTTP 状态</dt><dd>{numeric(last.httpStatus)}</dd></div><div className="sc-full"><dt>请求 ID</dt><dd><code>{last.requestId || "服务未返回"}</code></dd></div></dl>{last.message && <p className={last.status === "failed" ? "sc-verification-error" : "sc-note"}>{last.message}</p>}{last.errorCode && <p className="sc-note">错误码：{last.errorCode}</p>}{typeof last.retryAfterSeconds === "number" && <p className="sc-note">提供方建议等待 {last.retryAfterSeconds} 秒；系统不会自动重试。</p>}{!currentVerification && <p className="sc-note">这是历史配置的验证结果，不能证明当前 Key 可用。</p>}</> : <p className="sc-note">保存 Key 后，点击“验证真实搜索”。只有服务返回的结果和请求记录会显示在这里。</p>}</div>
    </div>
    {error && <p className="sc-error" role="alert"><AlertCircle size={16} />{error}</p>}{notice && <p className="sc-notice" role="status"><CheckCircle2 size={16} />{notice}</p>}
  </section>;
}
