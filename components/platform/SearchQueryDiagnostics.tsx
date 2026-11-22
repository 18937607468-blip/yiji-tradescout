import type { DiscoveryQuery } from "./discovery-types";

export default function SearchQueryDiagnostics({ query }: { query: DiscoveryQuery }) {
  const waitSeconds = Number.isFinite(query.retryAfterSeconds) && Number(query.retryAfterSeconds) >= 0 ? Number(query.retryAfterSeconds) : null;
  if (query.status !== "failed") return null;
  return <div className="ts-form-note">
    {(query.httpStatus || query.providerCode) && <p>服务回执：{query.httpStatus ? `HTTP ${query.httpStatus}` : "状态码未提供"}{query.providerCode ? ` · ${query.providerCode}` : ""}</p>}
    {query.providerMessage && query.providerMessage !== query.message && <p>{query.providerMessage}</p>}
    {waitSeconds !== null && <p>提供方建议至少等待 {waitSeconds} 秒再由你手动重试；这不保证额度已经恢复，本次没有自动重发。</p>}
    {query.providerCode === "daily_cap_reached" && <p>可在“设置 → 自动搜索连接”配置自己的 Tavily 搜索 Key，使用该账号的额度。B1X Key 只用于模型分析，不能代替搜索 Key。</p>}
  </div>;
}
