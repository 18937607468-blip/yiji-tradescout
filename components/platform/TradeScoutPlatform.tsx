"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Building2, CalendarCheck2, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDot, ClipboardList, Clock3, Copy, ExternalLink as ExternalLinkIcon, FileSearch, FileText, Filter, Globe2, HelpCircle, Inbox, LayoutDashboard, Loader2, Menu, Plus, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Truck, Upload, UserRound, X, AlertCircle } from "lucide-react";
import { Company, EMPTY_STATE, ModelCallSummary, ModelConnectionStatus, PlatformState, Section, Task, formatDate, hostname, isDemoCompany, isOverdue, isToday, localInputDate, safeUrl } from "./types";
import { Button, CompanyAvatar, EmptyState, ExternalLink, GradeBadge, Modal, SavedNotice } from "./PlatformUI";
import { CompanyEditor, ImportDialog } from "./CompanyForms";
import CompanyDrawer from "./CompanyDrawer";
import InquiryWorkspace from "./InquiryWorkspace";
import { HostedAccessBar, HostedModelConfig, ModelCallDetails, modelCallStatus } from "./HostedAccess";
import CustomsProspecting, { CustomsDraft, DEFAULT_CUSTOMS_DRAFT } from "./CustomsProspecting";
import CustomsImport from "./CustomsImport";
import SocialCapture from "./SocialCapture";
import FinancialReview from "./FinancialReview";
import BuyerDiscovery from "./BuyerDiscovery";
import AcquisitionHome from "./AcquisitionHome";
import SearchConfigPanel from "./SearchConfigPanel";
import { BrandMark, BrandRipples } from "./BrandWatermark";

type ModalType = "import" | "create" | "edit" | "task" | "customs" | "customs-import" | "social" | "financial" | "buyer-discovery" | null;
type Scope = "all" | "today" | "overdue" | "evidence";
type ImportSummary = { imported: number; duplicates: number; rejected: Array<{ row: number; reason: string }> };
const PRODUCT_CATEGORY_LABELS: Record<string, string> = { disc_brake_pad: "盘式制动片", brake_shoe: "制动蹄" };
const SECTION_LABELS: Record<Section, string> = { acquisition: "精准获客", inquiries: "询价与配型", customers: "客户工作台", products: "产品资料", followups: "跟进事项", settings: "设置与运行" };
const NAV = [{ key: "acquisition", label: "精准获客", icon: Search }, { key: "inquiries", label: "询价与配型", icon: ClipboardList }, { key: "customers", label: "客户工作台", icon: LayoutDashboard }, { key: "products", label: "产品资料", icon: BookOpen }, { key: "followups", label: "跟进事项", icon: CalendarCheck2 }, { key: "settings", label: "设置", icon: Settings2 }] as const;

function normalizeState(data: Partial<PlatformState>): PlatformState {
  return { ...EMPTY_STATE, ...data, inquiries: Array.isArray(data.inquiries) ? data.inquiries : [], fitmentRelations: Array.isArray(data.fitmentRelations) ? data.fitmentRelations : [], quoteHistory: Array.isArray(data.quoteHistory) ? data.quoteHistory : [], fitmentCatalog: Array.isArray(data.fitmentCatalog) ? data.fitmentCatalog : [], companies: Array.isArray(data.companies) ? data.companies : [], products: Array.isArray(data.products) ? data.products : [], events: Array.isArray(data.events) ? data.events : [], tasks: Array.isArray(data.tasks) ? data.tasks : [], runLog: Array.isArray(data.runLog) ? data.runLog : [], capabilities: { ...EMPTY_STATE.capabilities, ...data.capabilities } };
}

export default function TradeScoutPlatform({ signInHref, signOutHref }: { signInHref: string; signOutHref: string }) {
  const [state, setState] = useState<PlatformState>(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<Section>("acquisition");
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [grade, setGrade] = useState("all");
  const [product, setProduct] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalType>(null);
  const [importTab, setImportTab] = useState<"csv" | "url" | "text" | "image">("csv");
  const [discoverySeedId, setDiscoverySeedId] = useState("");
  const [discoveryRunId, setDiscoveryRunId] = useState<string | undefined>();
  const [customsDraft, setCustomsDraft] = useState<CustomsDraft>(DEFAULT_CUSTOMS_DRAFT);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [followFilter, setFollowFilter] = useState("open");
  const [shareUrl, setShareUrl] = useState("");
  const [nowTick, setNowTick] = useState(0);
  const [modelConnection, setModelConnection] = useState<ModelConnectionStatus | null>(null);
  const [modelConnectionLoading, setModelConnectionLoading] = useState(false);
  const [modelConnectionError, setModelConnectionError] = useState("");
  const modelStatusVersion = useRef(0);

  const loadModelStatus = useCallback(async () => {
    const version = ++modelStatusVersion.current;
    setModelConnectionLoading(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/platform/model-config", { cache: "no-store", signal: controller.signal });
      const body = await response.json() as { ok?: boolean; data?: ModelConnectionStatus; error?: { message?: string } };
      if (!response.ok || !body.ok || !body.data?.budget) throw new Error(body.error?.message || "模型状态暂未读取成功。");
      if (version === modelStatusVersion.current) { setModelConnection(body.data); setModelConnectionError(""); }
      return body.data;
    } catch (cause) {
      if (version === modelStatusVersion.current) setModelConnectionError(cause instanceof Error && cause.name === "AbortError" ? "状态读取超时，请刷新后核对今日调用与最近请求。" : cause instanceof Error ? cause.message : "模型状态暂未读取成功。");
      return null;
    } finally { clearTimeout(timeout); if (version === modelStatusVersion.current) setModelConnectionLoading(false); }
  }, []);

  const loadState = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/platform/state", { cache: "no-store", signal: controller.signal });
      const body: { ok?: boolean; data?: Partial<PlatformState>; error?: { message?: string } } = await response.json();
      if (!response.ok || !body.ok || !body.data) throw new Error(body.error?.message || `读取工作台失败（${response.status}）`);
      setState(normalizeState(body.data)); setLoaded(true); setError("");
    } catch (cause) { setError(cause instanceof Error && cause.name === "AbortError" ? "读取工作台超过 15 秒，请检查网络后点击刷新。已填写的内容仍保留。" : cause instanceof Error ? cause.message : "暂时无法读取工作台，请重试。"); }
    finally { clearTimeout(timeout); setLoading(false); }
  }, []);
  useEffect(() => { loadState(); }, [loadState]);
  useEffect(() => { if (loaded && section === "settings" && !busy) void loadModelStatus(); }, [loaded, section, state.updatedAt, state.identity?.authenticated, busy, loadModelStatus]);
  useEffect(() => { const timer = setInterval(() => setNowTick(x => x + 1), 60000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 6000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { setSelected([]); }, [query, grade, product, scope]);
  useEffect(() => {
    if (busy || modal || section === "inquiries") return;
    const refresh = () => { if (document.visibilityState === "visible") void loadState(true); };
    const timer = setInterval(refresh, 20000);
    window.addEventListener("focus", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [busy, modal, loadState, section]);

  const request = async (url: string, payload: Record<string, unknown>) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), url.endsWith("research") ? 90000 : 30000);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
      let body: { ok?: boolean; data?: Partial<PlatformState>; error?: { message?: string }; meta?: ImportSummary };
      try { body = await response.json(); } catch { throw new Error(`服务返回了无法读取的结果（${response.status}），请刷新查看保存状态。`); }
      if (body.data?.companies) { setState(normalizeState(body.data)); setLoaded(true); }
      if (!response.ok || !body.ok) throw new Error(body.error?.message || `操作未完成（${response.status}）`);
      if (!body.data?.companies) await loadState(true);
      return { data: body.data, meta: body.meta };
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") throw new Error("等待服务超时，结果状态暂不确定。请先刷新查看已保存的记录，再决定是否重试。");
      throw cause;
    } finally { clearTimeout(timeout); }
  };

  const action = async (type: string, payload: Record<string, unknown>) => {
    setBusy(type); setError(""); setNotice("");
    try {
      const previousIds = type === "create_company" ? new Set(state.companies.map(company => company.id)) : null;
      const result = await request("/api/platform/action", { type, payload });
      if (type === "create_company" && previousIds) {
        const normalizedName = (value: unknown) => String(value || "").normalize("NFKC").trim().toLowerCase();
        const created = (result.data?.companies || []).filter(company => !previousIds.has(company.id) && normalizedName(company.name) === normalizedName(payload.name));
        setDrawerId(created.length === 1 ? created[0].id : null);
      }
      setNotice(({ save_inquiry: "询价与配型依据已保存", add_quote_reference: "历史报价依据已保存", confirm_fitment: "限定条件下的对应关系已保存", create_company: "客户已保存", update_company: "客户与跟进安排已更新", add_communication: "沟通原文已保存到当前企业", add_task: "跟进事项已保存", update_task: "事项状态已更新", load_demo: "已载入带来源的案例与产品资料", propose_memory: "资料变化已提出，请核对原话后确认", apply_memory: "已确认的变化已应用，原话与历史仍保留" } as Record<string, string>)[type] || "记录已保存");
      if (["create_company", "update_company", "add_task"].includes(type)) setModal(null);
      if (type === "create_company") { if (section !== "inquiries" && section !== "acquisition") setSection("customers"); setScope("all"); setQuery(""); setGrade("all"); setProduct("all"); }
    } catch (cause) { const message = cause instanceof Error ? cause.message : "保存未完成，请重试。"; setError(message); throw new Error(message); }
    finally { setBusy(""); }
  };
  const safeAction = (type: string, payload: Record<string, unknown>) => { void action(type, payload).catch(() => {}); };
  const createDiscoveredCompany = async (payload: Record<string, unknown>): Promise<string | null> => {
    if (busy) throw new Error("当前操作尚未完成，请稍后保存。");
    const previousIds = new Set(state.companies.map(company => company.id));
    setBusy("create_company"); setError(""); setNotice("");
    try {
      const { data } = await request("/api/platform/action", { type: "create_company", payload });
      const added = (data?.companies || []).filter(company => !previousIds.has(company.id));
      const normalizedName = (value: unknown) => String(value || "").normalize("NFKC").trim().toLowerCase();
      const created = added.length === 1 && added[0].id !== discoverySeedId && normalizedName(added[0].name) === normalizedName(payload.name) ? added[0] : null;
      setSection("customers"); setScope("all"); setQuery(""); setGrade("all"); setProduct("all"); setSelected([]);
      if (created) setNotice("新客户已单独保存。可继续核验官网、产品和公开联系入口。");
      else { setDrawerId(null); setNotice("客户已保存，但无法唯一定位本次新增记录。请在客户库核对，勿重复创建。"); }
      return created?.id || null;
    } catch (cause) { const message = cause instanceof Error ? cause.message : "客户保存未完成，输入内容仍保留。"; setError(message); throw new Error(message); }
    finally { setBusy(""); }
  };
  const importCsv = async (csv: string) => {
    setBusy("import"); setError(""); setNotice("");
    try {
      const { meta } = await request("/api/platform/import", { csv });
      setSection("customers"); setScope("all"); setQuery(""); setGrade("all"); setProduct("all");
      const rejected = meta?.rejected || [];
      const summary = meta ? `新增 ${meta.imported} 家 · 跳过重复 ${meta.duplicates} 家 · 未导入 ${rejected.length} 行` : "导入结果已保存，请核对客户列表";
      if (rejected.length) {
        const reasons = rejected.slice(0, 3).map(item => `第 ${item.row} 行：${item.reason}`).join("；");
        throw new Error(`${summary}。${reasons}${rejected.length > 3 ? "；其余未导入行请检查原表" : ""}。CSV 内容已保留，请修正后重试；已保存的企业会按去重规则跳过。`);
      }
      setModal(null); setNotice(summary);
    }
    catch (cause) { const message = cause instanceof Error ? cause.message : "导入未完成，请检查 CSV。"; setError(message); throw new Error(message); }
    finally { setBusy(""); }
  };
  const research = async (company: Company) => {
    setBusy(`research:${company.id}`); setError("");
    try { await request("/api/platform/research", { companyId: company.id }); setNotice("网站研究记录已保存，请核对原文依据"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "研究未完成，已保存的证据仍可查看。"); }
    finally { setBusy(""); }
  };
  const researchSelected = async () => {
    const ids = selected.slice(0, 4); if (!ids.length) return;
    setError(""); const failures: string[] = [];
    for (const id of ids) {
      setBusy(`research:${id}`);
      try { await request("/api/platform/research", { companyId: id }); }
      catch (cause) { const company = state.companies.find(item => item.id === id); failures.push(`${company?.name || "客户"}：${cause instanceof Error ? cause.message : "未完成"}`); }
    }
    setBusy("");
    if (failures.length) setError(failures.join("\n"));
    else setNotice(`${ids.length} 家客户的研究记录已保存`);
  };
  const modelConfigAction = async (operation: "model-config" | "model-verify", payload: Record<string, unknown>): Promise<ModelConnectionStatus> => {
    if (busy) throw new Error("当前操作进行中，请完成后再修改模型配置。");
    setBusy(operation); setError(""); setModelConnectionError("");
    modelStatusVersion.current++; setModelConnectionLoading(false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), operation === "model-verify" ? 35000 : 15000);
    try {
      const response = await fetch("/api/platform/model-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
      let body: { ok?: boolean; data?: ModelConnectionStatus; error?: { message?: string } };
      try { body = await response.json(); } catch { throw new Error(`模型服务返回了无法读取的结果（${response.status}），请核对运行记录。`); }
      if (!response.ok || !body.ok || !body.data?.budget) throw new Error(body.error?.message || `操作未完成（${response.status}）。`);
      setModelConnection(body.data);
      await loadState(true);
      return body.data;
    } catch (cause) {
      await Promise.all([loadModelStatus(), loadState(true)]);
      throw new Error(cause instanceof Error && cause.name === "AbortError" ? "请求等待超时，结果暂不确定。已刷新状态，请先核对最近请求再重试。" : cause instanceof Error ? cause.message : "操作未完成，请查看最新模型状态。");
    } finally { clearTimeout(timeout); setBusy(""); }
  };
  const saveModelConfig = (key: string) => modelConfigAction("model-config", { mode: "save", key });
  const verifyModelConnection = () => modelConfigAction("model-verify", { mode: "verify_connection" });
  const exportCsv = async () => {
    setBusy("export"); setError("");
    try {
      const response = await fetch("/api/platform/export.csv", { cache: "no-store" });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: { message?: string } }; throw new Error(body.error?.message || "导出失败，请重试。"); }
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `冠英客户跟进表_${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      setNotice("跟进表已导出，包含客户分级、安排与来源");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "导出未完成。"); }
    finally { setBusy(""); }
  };

  const navigate = (value: Section) => { setSection(value); setMobileNav(false); setError(""); };
  const openModal = (value: ModalType) => { setError(""); if (value === "import") setImportTab("csv"); setModal(value); };
  const openWebsiteImport = () => { setError(""); setImportTab("url"); setModal("import"); };
  const drawerCompany = state.companies.find(item => item.id === drawerId);
  const discoverySeed = state.companies.find(item => item.id === discoverySeedId);
  const openDiscovery = (companyId: string, runId?: string) => { setDiscoverySeedId(companyId); setDiscoveryRunId(runId); openModal("buyer-discovery"); };
  const todayCompanies = state.companies.filter(item => isToday(item.nextFollowUpAt));
  const overdueCompanies = state.companies.filter(item => isOverdue(item.nextFollowUpAt));
  const missingCompanies = state.companies.filter(item => !item.grade || item.grade === "unknown" || !!item.missingEvidence?.length);
  const openTasks = state.tasks.filter(item => item.status !== "done");
  const filtered = useMemo(() => {
    const anchor = state.products.find(item => item.id === product);
    return state.companies.filter(item => {
      const content = [item.name, item.website, item.market, item.buyerRole, item.owner, ...(item.productRefs || [])].join(" ").toLowerCase();
      if (query && !content.includes(query.toLowerCase().trim())) return false;
      if (grade !== "all" && (item.grade || "unknown") !== grade) return false;
      if (scope === "today" && !isToday(item.nextFollowUpAt)) return false;
      if (scope === "overdue" && !isOverdue(item.nextFollowUpAt)) return false;
      if (scope === "evidence" && item.grade && item.grade !== "unknown" && !item.missingEvidence?.length) return false;
      if (anchor && !anchor.codes.some(code => (item.productRefs || []).some(ref => ref.toLowerCase().includes(code.value.toLowerCase())))) return false;
      return true;
    });
  }, [state.companies, state.products, query, grade, scope, product, nowTick]);
  const toggleSelected = (id: string) => { setSelected(values => values.includes(id) ? values.filter(value => value !== id) : values.length < 4 ? [...values, id] : values); };
  const toggleFirstFour = () => { const ids = filtered.slice(0, 4).map(item => item.id); setSelected(values => ids.every(id => values.includes(id)) ? [] : ids); };

  const productAnchors = <label className="ts-anchor-select"><CircleDot size={17} /><span>产品锚点</span><select aria-label="筛选产品锚点" value={product} onChange={event => { setProduct(event.target.value); setSection("customers"); }}><option value="all">全部制动件</option>{state.products.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={14} /></label>;
  const drawCompany = (company: Company) => { setDrawerId(company.id); setError(""); };

  return <div className="ts-app ts-waterlily">
    {mobileNav && <button className="ts-nav-backdrop" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}
    <aside className={`ts-sidebar ${mobileNav ? "is-open" : ""}`}>
      <button className="ts-brand" onClick={() => navigate("acquisition")} aria-label="投石问路 · 返回精准获客"><span className="ts-brand-icon"><BrandMark /></span><span><strong>投石问路</strong><small>冠英 TradeScout</small></span></button>
      <div className="ts-workspace-label">外贸业务空间</div>
      <nav aria-label="工作台导航">{NAV.map(({ key, label, icon: Icon }) => <button key={key} className={section === key ? "active" : ""} onClick={() => navigate(key)} aria-current={section === key ? "page" : undefined}><Icon size={19} /><span>{label}</span>{key === "followups" && loaded && openTasks.length > 0 && <b>{openTasks.length}</b>}</button>)}</nav>
      <div className="ts-sidebar-context"><span className="ts-sidebar-serial">01 — KEEP EXPLORING</span><strong>每条线索，<br />都值得问对下一步。</strong><p>原文可回看<br />记忆可更新<br />跟进有连续性</p><div><span className="ts-dot" />商用车制动件 · B2B 外贸</div></div>
      <div className="ts-sidebar-bottom"><button className="ts-sidebar-settings-link" onClick={() => navigate("settings")}><HelpCircle size={17} />在线运行状态</button><div className="ts-team"><span>壹</span><div><strong>壹击 · 冠英外贸</strong><small>{state.identity?.authenticated ? "当前账号工作区" : "访客独立工作区"}</small></div><ShieldCheck size={16} /></div></div>
    </aside>

    <div className="ts-main-shell">
      <header className="ts-topbar"><div className="ts-breadcrumb"><button className="ts-icon-button ts-menu-toggle" aria-label="打开导航" onClick={() => setMobileNav(true)}><Menu size={21} /></button><span>外贸业务</span><ChevronRight size={14} /><strong>{SECTION_LABELS[section]}</strong></div><div className="ts-topbar-right"><span className={`ts-sync-state ${error && !loaded ? "is-error" : ""}`}><span className="ts-dot" />{loading ? "正在读取记录" : loaded ? "云端独立记录" : "等待连接"}</span><button className="ts-icon-button" aria-label="刷新工作台数据" title="刷新工作台数据" disabled={!!busy || loading} onClick={() => loadState()}><RefreshCw size={17} className={loading ? "ts-spin" : ""} /></button></div></header>
      <main className="ts-content">
        <div className={`ts-page-heading ${section === "acquisition" ? "ts-brand-heading" : ""}`}><div>{section === "acquisition" && <BrandRipples />}<div className="ts-eyebrow">TRADE SCOUT / KOOYING</div><div className="ts-title-line"><h1>{section === "acquisition" ? "投石问路" : SECTION_LABELS[section]}</h1>{section === "acquisition" && <span className="ts-brand-tagline">让每条线索，都有下一步。</span>}</div><p>{({ acquisition: "面向商用车制动件外贸的获客与询价跟进工作台。", inquiries: "已知条件 → 候选结果 → 缺失条件 → 下一步核对，保留每次判断依据。", customers: "先看为什么值得联系，再确定由谁、在何时、推进什么。", products: "用可回看的 OE / WVA 编号连接产品、来源与客户。", followups: "按实际日期安排下一步，让已承诺的跟进有处可查。", settings: "模型、搜索、官网读取分别记录状态；保存配置后仍需真实验证。" })[section]}</p></div>
          <div className="ts-heading-actions">{section === "customers" && <><Button onClick={exportCsv} disabled={!!busy || !loaded || !state.companies.length} busy={busy === "export"}><ArrowDownToLine size={16} />导出跟进表</Button><Button variant="primary" onClick={() => openModal("import")} disabled={!!busy || !loaded}><Upload size={16} />导入线索</Button></>}{section === "followups" && <Button variant="primary" onClick={() => openModal("task")} disabled={!state.companies.length || !!busy}><Plus size={17} />新建跟进事项</Button>}{section === "products" && <Button onClick={() => { navigate("customers"); openModal("import"); }} disabled={!loaded}><Upload size={16} />按产品导入线索</Button>}</div>
        </div>

        <div className="ts-workspace-status"><HostedAccessBar identity={state.identity} loaded={loaded} signInHref={signInHref} signOutHref={signOutHref} />
        {loaded && !state.capabilities.modelConfigured && section !== "settings" && section !== "inquiries" && <button className="ts-model-status-link" onClick={() => navigate("settings")}><span className="ts-status-dot" /><span>B1X 分析未配置</span><ArrowUpRight size={14} /></button>}</div>
        {error && !drawerCompany && !modal && <div className="ts-error-banner" role="alert"><AlertCircle size={18} /><p>{error}</p><Button variant="quiet" onClick={() => loadState()} disabled={!!busy}>刷新状态</Button><button className="ts-icon-button" onClick={() => setError("")} aria-label="关闭错误提示"><X size={17} /></button></div>}
        {notice && <SavedNotice>{notice}</SavedNotice>}

        <div hidden={section !== "acquisition"}><AcquisitionHome state={state} loaded={loaded} busy={busy} onStart={companyId => openDiscovery(companyId)} onResume={openDiscovery} onCreate={() => openModal("create")} onLoadExample={() => safeAction("load_demo", {})} onCustomers={() => navigate("customers")} onCustoms={() => openModal("customs")} onImport={() => openModal("import")} onWebsite={openWebsiteImport} onSocial={() => openModal("social")} onOpenCompany={id => { setDrawerId(id); setError(""); }} /></div>

        <div hidden={section !== "inquiries"}><InquiryWorkspace state={state} loaded={loaded} busy={busy} onAction={action} onCreateCustomer={() => openModal("create")} /></div>

        {section === "customers" && <>
          <div className="ts-stats-grid">{([
            { key: "all", title: "全部客户", count: state.companies.length, icon: Building2, text: "已保存的企业记录" },
            { key: "today", title: "今日待跟进", count: todayCompanies.length, icon: CalendarDays, text: "按北京时间的今日安排" },
            { key: "overdue", title: "已逾期", count: overdueCompanies.length, icon: Clock3, text: "含今天已过期的安排" },
            { key: "evidence", title: "待补证", count: missingCompanies.length, icon: FileSearch, text: "资料不足或存在待核验项" },
          ] as const).map(({ key, title, count, icon: Icon, text }) => <button key={key} className={`ts-stat ${scope === key ? "is-selected" : ""} ${key === "overdue" && count > 0 ? "is-attention" : ""}`} onClick={() => setScope(key)}><div className="ts-stat-title"><span>{title}</span><Icon size={19} /></div><strong>{loaded ? count : "—"}<small>家</small></strong><span className="ts-stat-caption">{text}</span></button>)}</div>
          <section className="ts-panel ts-customer-panel">
            <div className="ts-panel-header"><div><h2>客户开发清单 <span>{loaded ? filtered.length : "—"}</span></h2><p>分级决定优先顺序，阶段记录实际进展。</p></div><div className="ts-customer-entry-actions"><Button onClick={() => openModal("social")} disabled={!loaded || !!busy}><Upload size={16} />社媒资料</Button><Button onClick={() => openModal("customs")} disabled={!!busy}><Globe2 size={16} />海关找客</Button><Button variant="quiet" onClick={() => openModal("create")} disabled={!loaded || !!busy}><Plus size={17} />添加客户</Button></div></div>
            <div className="ts-table-toolbar"><div className="ts-search-field"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索公司、型号、市场或负责人" placeholder="搜索公司、型号、市场或负责人" />{query && <button onClick={() => setQuery("")} aria-label="清除搜索"><X size={14} /></button>}</div><div className="ts-toolbar-select"><Filter size={15} /><select aria-label="筛选客户分级" value={grade} onChange={event => setGrade(event.target.value)}><option value="all">全部分级</option><option value="A">A 优先跟进</option><option value="B">B 值得开发</option><option value="C">C 暂缓投入</option><option value="unknown">待补证</option></select><ChevronDown size={13} /></div>{productAnchors}</div>
            {selected.length > 0 && <div className="ts-selection-bar"><span><Check size={15} />已选 {selected.length} 家<span className="ts-selection-note">每轮最多 4 家</span></span><div><button onClick={() => setSelected([])} disabled={!!busy}>清除选择</button><Button variant="primary" onClick={researchSelected} disabled={!!busy} busy={busy.startsWith("research:")}><Search size={15} />{state.capabilities.modelConfigured ? `深查这 ${selected.length} 家` : `获取这 ${selected.length} 家原文`}</Button></div></div>}
            {loading && !loaded ? <div className="ts-loading"><Loader2 className="ts-spin" size={24} /><strong>正在读取客户记录</strong><span>连接当前工作区…</span></div> : !loaded ? <EmptyState title="暂时无法连接工作区" description="请检查网络连接或稍后重试，重新读取在线工作区。"><Button onClick={() => loadState()}><RefreshCw size={16} />重新读取</Button></EmptyState> : state.companies.length === 0 ? <EmptyState icon={<Building2 size={29} />} title="让第一条客户线索有据可查" description="导入现有客户表、粘贴公开企业网址，或手工建立一条企业记录。未知信息可以留待核验。"><Button variant="primary" onClick={() => openModal("import")}><Upload size={16} />导入客户线索</Button><Button onClick={() => openModal("create")}><Plus size={16} />手工添加</Button></EmptyState> : filtered.length === 0 ? <EmptyState compact icon={<Search size={25} />} title="当前条件下没有客户" description="调整搜索词、产品或分级，查看其他已保存记录。"><Button onClick={() => { setQuery(""); setGrade("all"); setProduct("all"); setScope("all"); }}>清除筛选</Button></EmptyState> : <div className="ts-table-scroll"><table className="ts-customer-table"><thead><tr><th className="ts-check-cell"><input type="checkbox" aria-label="选择当前列表前四家客户" checked={filtered.slice(0, 4).length > 0 && filtered.slice(0, 4).every(item => selected.includes(item.id))} onChange={toggleFirstFour} disabled={!!busy} /></th><th>企业 / 市场</th><th>产品关联</th><th>买家角色</th><th>分级</th><th>阶段</th><th>下一步与跟进</th><th className="ts-row-arrow"><span className="ts-sr-only">查看</span></th></tr></thead><tbody>{filtered.map(company => <tr key={company.id} onClick={() => drawCompany(company)} className={selected.includes(company.id) ? "is-selected" : ""}><td className="ts-check-cell" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`选择 ${company.name}`} checked={selected.includes(company.id)} disabled={!!busy || (!selected.includes(company.id) && selected.length >= 4)} onChange={() => toggleSelected(company.id)} /></td><td data-label="企业 / 市场"><div className="ts-company-cell"><CompanyAvatar company={company} small /><div><button className="ts-company-name" onClick={() => drawCompany(company)}>{company.name}</button><div className="ts-company-meta"><span>{company.market || "市场待核验"}</span>{isDemoCompany(company) ? <span className="ts-demo-tag">{company.dataClass === "synthetic" ? "演示样例" : "来源案例"}</span> : <span>{hostname(company.website)}</span>}</div><div className="ts-company-evidence-status"><span className={`ts-status-dot ${company.evidence?.length ? "has-source" : ""}`} />{company.evidence?.length ? `${company.evidence.length} 条来源 · 结论待核对` : "来源待补充"}</div></div></div></td><td data-label="产品关联"><div className="ts-table-codes">{company.productRefs?.length ? <>{company.productRefs.slice(0, 2).map(value => <code key={value}>{value}</code>)}{company.productRefs.length > 2 && <span>+{company.productRefs.length - 2}</span>}</> : <span className="ts-muted">型号待确认</span>}</div></td><td data-label="买家角色"><span className="ts-role-label">{company.buyerRole || "待核验"}</span>{company.researchStatus === "evidence_only" && <small className="ts-cell-note">已取原文 · 待分析</small>}{company.researchStatus === "failed" && <small className="ts-cell-note ts-overdue-text">研究未完成</small>}</td><td data-label="分级"><GradeBadge grade={company.grade} /></td><td data-label="阶段"><span className="ts-stage">{company.stage || "待研究"}</span></td><td data-label="下一步与跟进" className="ts-follow-cell"><strong>{company.nextAction || "尚未安排下一步"}</strong><div className={isOverdue(company.nextFollowUpAt) ? "ts-overdue-text" : "ts-muted"}><CalendarDays size={13} />{company.nextFollowUpAt ? `${formatDate(company.nextFollowUpAt, true)}${isOverdue(company.nextFollowUpAt) ? " · 逾期" : ""}` : "未安排日期"}{company.owner && <span>· {company.owner}</span>}</div></td><td className="ts-row-arrow"><ChevronRight size={17} /></td></tr>)}</tbody></table></div>}
            <div className="ts-table-footer"><span><ShieldCheck size={14} />采购意向与同行采购关系均需单独核验</span><span>{loaded ? `当前 ${filtered.length} / ${state.companies.length} 家` : "等待真实数据"}</span></div>
          </section>
          {loaded && state.companies.length === 0 && <div className="ts-example-strip"><span className="ts-example-icon"><FileText size={20} /></span><div><strong>先看一条有来源的真实案例</strong><p>载入冠英官方产品资料与 Proxel 公开企业案例。它是待开发候选，不是已成交客户。</p></div><Button onClick={() => safeAction("load_demo", {})} busy={busy === "load_demo"} disabled={!!busy}>载入来源案例<ArrowRight size={15} /></Button></div>}
          <RunLog entries={state.runLog} updatedAt={state.updatedAt} />
        </>}

        {section === "products" && <>
          <section className="ts-product-intro"><figure className="ts-official-product-photo"><img src="/platform/product-29181.jpg" alt="冠英官方29181盘式制动片实物照片" /><figcaption>官方实物图 · 29181 盘式片</figcaption></figure><div><span className="ts-eyebrow">COMMERCIAL VEHICLE BRAKING</span><h2>让型号成为客户研究的起点</h2><p>分清 OE、WVA 与企业内部编号，保留规格冲突和材料页码。</p></div><span className="ts-count-pill">{state.products.length} 项产品资料</span></section>
          {state.products.length ? <div className="ts-products-grid">{state.products.map(item => <article className="ts-product-card" key={item.id}><div className="ts-product-card-top"><div className="ts-product-illustration"><CircleDot size={41} strokeWidth={1.1} /><span>{PRODUCT_CATEGORY_LABELS[item.category] || item.category || "制动部件"}</span></div><span className="ts-source-pill"><FileText size={13} />企业资料</span></div><h3>{item.name}</h3><dl>{item.codes.map((code, index) => <div key={`${code.namespace}-${index}`}><dt>{code.namespace.toUpperCase() === "INTERNAL" ? "企业内部编号" : code.namespace}</dt><dd><code>{code.value}</code></dd></div>)}</dl>{item.notes && <p>{item.notes}</p>}<div className="ts-product-source"><FileText size={14} /><span>{typeof item.source === "string" ? item.source : "来源待补充"}</span></div><Button onClick={() => { setQuery(""); setGrade("all"); setScope("all"); setSelected([]); setProduct(item.id); navigate("customers"); }}>查看关联客户<ArrowRight size={15} /></Button></article>)}</div> : <section className="ts-panel"><EmptyState icon={<BookOpen size={28} />} title="还没有产品锚点" description="可载入官方材料中已核验的编号与来源。产品相似或同码只作候选线索，不自动确认适配或采购。"><Button variant="primary" onClick={() => safeAction("load_demo", {})} disabled={!!busy} busy={busy === "load_demo"}>载入带来源的产品与案例</Button></EmptyState></section>}
          <div className="ts-info-box ts-product-note"><ShieldCheck size={19} /><p>材质、尺寸、包装数量与 MOQ 分别记录。不同版本材料存在冲突时，以原件核对和企业确认结果为准。</p></div>
        </>}

        {section === "followups" && <>
          <div className="ts-followup-summary"><div><CalendarDays size={21} /><span>今日跟进客户</span><strong>{todayCompanies.length}</strong></div><div><Clock3 size={21} /><span>已逾期客户</span><strong className={overdueCompanies.length ? "ts-overdue-text" : ""}>{overdueCompanies.length}</strong></div><div><ClipboardList size={21} /><span>未完成事项</span><strong>{openTasks.length}</strong></div></div>
          <section className="ts-panel"><div className="ts-panel-header"><div><h2>客户跟进安排</h2><p>今日与逾期可重叠；列表时间统一为北京时间。</p></div><div className="ts-segmented">{[["open", "全部安排"], ["today", "今日"], ["overdue", "逾期"]].map(([key, label]) => <button key={key} className={followFilter === key ? "active" : ""} onClick={() => setFollowFilter(key)}>{label}</button>)}</div></div>
            <FollowUpList companies={state.companies.filter(item => !!item.nextFollowUpAt && (followFilter === "today" ? isToday(item.nextFollowUpAt) : followFilter === "overdue" ? isOverdue(item.nextFollowUpAt) : true)).sort((a, b) => new Date(a.nextFollowUpAt!).getTime() - new Date(b.nextFollowUpAt!).getTime())} onSelect={drawCompany} />
          </section>
          <section className="ts-panel ts-tasks-panel"><div className="ts-panel-header"><div><h2>独立跟进事项 <span>{state.tasks.length}</span></h2><p>勾选只表示事项完成，不自动将客户标记为成交。</p></div><Button variant="quiet" onClick={() => openModal("task")} disabled={!state.companies.length || !!busy}><Plus size={16} />新增事项</Button></div>{state.tasks.length ? <div className="ts-task-list">{[...state.tasks].sort((a, b) => Number(a.status === "done") - Number(b.status === "done")).map(task => <div className={`ts-task-item ${task.status === "done" ? "is-done" : ""}`} key={task.id}><button className="ts-task-check" aria-label={`${task.status === "done" ? "重新打开" : "完成"}事项：${task.title}`} onClick={() => safeAction("update_task", { id: task.id, status: task.status === "done" ? "open" : "done" })} disabled={!!busy}>{task.status === "done" && <Check size={15} />}</button><div><strong>{task.title}</strong><button onClick={() => setDrawerId(task.companyId)}>{state.companies.find(item => item.id === task.companyId)?.name || "关联企业"}<ArrowUpRight size={12} /></button></div><span className={task.status !== "done" && isOverdue(task.dueAt) ? "ts-overdue-text" : "ts-muted"}>{formatDate(task.dueAt, true)}</span><span className="ts-task-owner">{task.owner || "未分配"}</span></div>)}</div> : <EmptyState compact icon={<CalendarCheck2 size={26} />} title="暂无独立跟进事项" description="给客户安排具体行动、负责人和时间，在这里确认完成。" />}</section>
        </>}

        {section === "settings" && <div className="ts-settings-grid"><section className="ts-panel ts-settings-panel"><h2>当前运行环境</h2><div className="ts-connection-row"><span className="ts-connection-icon"><CircleDot size={23} /></span><div><strong>B1X 模型连接</strong><p>{modelConnection ? !modelConnection.configured ? "当前账号尚未保存 B1X 配置。" : modelConnection.currentConfigVerified ? "当前配置有成功调用记录，最近请求与消耗可在右侧查看。" : "配置已保存，尚无当前 Key 的成功调用记录。可单独验证连接。" : "模型状态读取后显示；保存配置不代表已验证连接。"}</p></div><span className={`ts-status-pill ${modelConnection?.currentConfigVerified ? "ready" : "pending"}`}>{modelConnection ? !modelConnection.configured ? "尚未配置" : modelConnection.currentConfigVerified ? "已有验证" : "尚未验证" : "等待读取"}</span></div><div className="ts-connection-row"><span className="ts-connection-icon"><Globe2 size={23} /></span><div><strong>公开网页取证</strong><p>根据企业网址获取原文。抓取失败会显示真实状态。</p></div><span className={`ts-status-pill ${state.capabilities.websiteFetch ? "ready" : "pending"}`}>{state.capabilities.websiteFetch ? "可发起请求" : "待确认"}</span></div><div className="ts-connection-row"><span className="ts-connection-icon"><Search size={23} /></span><div><strong>真实网页搜索 · Tavily</strong><p>{state.capabilities.searchConfigured ? "独立搜索 Key 与真实验证见下方“自动搜索连接”；B1X 继续用于客户深研。" : "可使用 CSV、企业网址与授权文本导入线索。"}</p></div><span className={`ts-status-pill ${state.capabilities.searchConfigured ? "ready" : "pending"}`}>{state.capabilities.searchConfigured ? "可发起请求" : "使用导入"}</span></div><div className="ts-settings-actions"><Button onClick={async () => { await Promise.all([loadState(), loadModelStatus()]); }} busy={loading || modelConnectionLoading} disabled={!!busy}><RefreshCw size={16} />刷新配置状态</Button><a href="/api/health" target="_blank" rel="noopener noreferrer" className="ts-button ts-button-secondary">查看服务状态</a></div></section>
          <HostedModelConfig identity={state.identity} capabilities={state.capabilities} connection={modelConnection} connectionLoading={modelConnectionLoading} connectionError={modelConnectionError} signInHref={signInHref} onSave={saveModelConfig} onVerify={verifyModelConnection} onRefresh={loadModelStatus} busy={busy} />
          <SearchConfigPanel signInHref={signInHref} disabled={!!busy} />
          <section className="ts-panel ts-settings-panel ts-span-2"><h2>手机与电脑访问</h2><p className="ts-muted">队友或评委可以打开同一个网址体验。访客与不同账号的客户记录相互独立；需要查看同一份记录时，请在两台设备登录同一 ChatGPT 账号。</p><Button onClick={async () => { const url = `${window.location.origin}/`; setShareUrl(url); try { if (!navigator.clipboard) throw new Error(); await navigator.clipboard.writeText(url); setNotice("在线工作台网址已复制"); } catch { setNotice("请从下方地址框手动复制网址"); } }}><Copy size={16} />复制在线工作台网址</Button>{shareUrl && <input className="ts-share-url" aria-label="在线工作台网址" readOnly value={shareUrl} onFocus={event => event.target.select()} />}<p className="ts-form-note">页面打开时每 20 秒刷新记录，也可以使用右上角刷新按钮；编辑表单打开期间暂停自动刷新。</p></section>
          <section className="ts-panel ts-settings-panel ts-span-2"><h2>数据与来源原则</h2><div className="ts-principles"><div><ShieldCheck size={20} /><strong>来源可回看</strong><p>原文、公开网址、时间与判断分别保存。</p></div><div><UserRound size={20} /><strong>业务员确认阶段</strong><p>分级可编辑，成交与寄样不由模型自行认定。</p></div><div><FileText size={20} /><strong>导出继续跟进</strong><p>通用 CSV 包含业务字段，不假定已接入其他 CRM。</p></div></div><p className="ts-attribution">基于 Fire Enrich（MIT）构建 · 冠英商用车制动件业务工作台</p></section></div>}
        <footer className="ts-page-footer"><span><span className="ts-footer-ripple" aria-hidden="true">◎</span> 投石问路 / 壹击 · 湖州</span><span>{state.updatedAt ? `记录更新时间 ${formatDate(state.updatedAt, true)}` : "业务记录与原文证据同步保存"}</span></footer>
      </main>
    </div>
    {drawerCompany && <CompanyDrawer company={drawerCompany} events={state.events} onClose={() => { setDrawerId(null); setError(""); }} onEdit={() => openModal("edit")} onResearch={research} onFinancialReview={() => openModal("financial")} onFindBuyers={() => openDiscovery(drawerCompany.id)} onUpdated={data => { setState(normalizeState(data)); setLoaded(true); setError(""); }} onAction={action} busy={busy} error={!modal ? error : undefined} modelConfigured={state.capabilities.modelConfigured} />}
    {(modal === "create" || modal === "edit") && <CompanyEditor company={modal === "edit" ? drawerCompany : undefined} companies={state.companies} onOpenExisting={id => { setModal(null); setDrawerId(id); setError(""); }} onSave={action} onClose={() => { setModal(null); setError(""); }} busy={!!busy} error={error} />}
    {modal === "customs" && <CustomsProspecting draft={customsDraft} onChange={setCustomsDraft} onClose={() => setModal(null)} onImportCandidates={() => openModal("customs-import")} />}
    {modal === "customs-import" && <CustomsImport onClose={() => setModal(null)} onImported={(data, summary) => {
      setState(normalizeState(data)); setLoaded(true); setError("");
      setSection("customers"); setScope("all"); setQuery(""); setGrade("all"); setProduct("all"); setSelected([]);
      setNotice(`海关资料已保存：新增 ${summary.importedCompanies} 家，合并 ${summary.mergedCompanies} 家；新增来源记录 ${summary.importedRecords} 条。`);
    }} />}
    {modal === "social" && <SocialCapture state={state} onClose={() => setModal(null)} onSaved={(data) => {
      setState(normalizeState(data)); setLoaded(true); setError("");
    }} />}
    {modal === "buyer-discovery" && discoverySeed && <BuyerDiscovery key={`${discoverySeed.id}:${discoveryRunId || "new"}`} state={state} seedCompany={discoverySeed} initialRunId={discoveryRunId} onClose={() => setModal(null)} onCreateCompany={createDiscoveredCompany} onOpenCompany={(companyId) => { setModal(null); setDrawerId(companyId); setSection("customers"); setError(""); }} onUpdated={(data) => {
      setState(normalizeState(data)); setLoaded(true); setError("");
    }} />}
    {modal === "financial" && <FinancialReview state={state} initialCompanyId={drawerCompany?.id} onClose={() => setModal(null)} onSaved={(data) => {
      setState(normalizeState(data)); setLoaded(true); setError("");
    }} />}
    {modal === "import" && <ImportDialog initialTab={importTab} onImport={importCsv} onCreate={action} onClose={() => { setModal(null); setError(""); }} busy={!!busy} error={error} />}
    {modal === "task" && <TaskDialog companies={state.companies} onSave={action} onClose={() => { setModal(null); setError(""); }} busy={!!busy} error={error} />}
  </div>;
}

function FollowUpList({ companies, onSelect }: { companies: Company[]; onSelect: (company: Company) => void }) {
  return companies.length ? <div className="ts-followup-list">{companies.map(company => <button key={company.id} onClick={() => onSelect(company)}><span className={`ts-due-box ${isOverdue(company.nextFollowUpAt) ? "overdue" : ""}`}><strong>{formatDate(company.nextFollowUpAt)}</strong><small>{new Date(company.nextFollowUpAt!).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" })}</small></span><div className="ts-followup-main"><strong>{company.nextAction || "核验客户信息与下一步"}</strong><span>{company.name} · {company.market || "市场待核验"}</span></div><GradeBadge grade={company.grade} /><span className="ts-task-owner"><UserRound size={14} />{company.owner || "未分配"}</span><ChevronRight size={17} /></button>)}</div> : <EmptyState compact icon={<CalendarDays size={27} />} title="当前没有到期安排" description="在客户详情中设置下一步与跟进时间，安排会显示在这里。" />;
}

function TaskDialog({ companies, onSave, onClose, busy, error }: { companies: Company[]; onSave: (type: string, payload: Record<string, unknown>) => Promise<void>; onClose: () => void; busy: boolean; error?: string }) {
  const [localError, setLocalError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return; setLocalError("");
    const data = new FormData(event.currentTarget);
    const companyId = String(data.get("companyId") || "");
    const title = String(data.get("title") || "").trim();
    const dueAt = String(data.get("dueAt") || "");
    if (!companies.some(company => company.id === companyId)) { setLocalError("请选择仍在当前工作区的客户。"); return; }
    if (!title) { setLocalError("请填写具体事项，不能只输入空格。"); return; }
    if (!dueAt || !Number.isFinite(Date.parse(dueAt))) { setLocalError("请填写有效的计划时间。"); return; }
    try { await onSave("add_task", { companyId, title, dueAt: new Date(dueAt).toISOString(), owner: String(data.get("owner") || "").trim() }); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : "事项未保存，输入内容已保留，请重试。"); }
  };
  return <Modal title="新建跟进事项" description="把具体行动关联到客户，保存负责人和日期。" onClose={onClose}><form className="ts-form" onSubmit={submit}><div className="ts-form-grid"><label className="ts-field ts-span-2">关联客户<select name="companyId" required>{companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label><label className="ts-field ts-span-2">事项内容 *<input name="title" required maxLength={200} placeholder="例如：询问采购负责人是否接受样品验证" /></label><label className="ts-field">负责人<input name="owner" placeholder="业务员姓名" /></label><label className="ts-field">计划时间 *<input type="datetime-local" name="dueAt" required defaultValue={localInputDate(new Date(Date.now() + 86400000).toISOString())} /></label></div>{(localError || error) && <p className="ts-inline-error" role="alert">{localError || error}</p>}<footer className="ts-modal-footer"><Button type="button" onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy}>保存跟进事项</Button></footer></form></Modal>;
}

function RunLog({ entries, updatedAt }: { entries: Array<Record<string, unknown>>; updatedAt?: string }) {
  const labels: Record<string, string> = { in_flight: "正在运行", evidence_saved: "原文已保存", complete: "完成", blocked: "分析未运行", response_received: "收到响应", validated: "已校验引用", failed: "失败", outcome_unknown: "结果待确认" };
  return <details className="ts-run-log"><summary><div><Clock3 size={15} /><span>运行与取证记录</span><b>{entries.length}</b></div><ChevronDown size={15} /></summary>{entries.length ? <div className="ts-run-log-list">{entries.slice(-8).reverse().map((entry, index) => {
    const usage = entry.usage as { totalTokens?: number } | undefined;
    const detail = [typeof entry.pagesFetched === "number" ? `已取 ${entry.pagesFetched} 页原文` : "", typeof usage?.totalTokens === "number" ? `${usage.totalTokens} tokens（服务返回）` : entry.type === "model_call" ? "Token 用量：服务未返回" : "", entry.errorCode ? `状态码 ${String(entry.errorCode)}` : ""].filter(Boolean).join(" · ");
    return <div key={String(entry.id || index)}><span className="ts-run-status">{entry.type === "model_call" ? modelCallStatus(String(entry.status || "")) : labels[String(entry.status)] || String(entry.status || "已记录")}</span><div><strong>{String(entry.title || entry.label || entry.action || ({ website_research: "网站原文研究", model_call: "模型分析请求" }[String(entry.type)] || entry.type) || "运行记录")}</strong><p>{String(entry.message || entry.summary || detail || "查看客户原文依据了解详情")}</p>{entry.type === "model_call" && <details className="ts-run-model-details"><summary>请求与消耗明细</summary><ModelCallDetails call={entry as Partial<ModelCallSummary>} /></details>}</div><time>{formatDate(String(entry.startedAt || entry.createdAt || entry.timestamp || updatedAt || ""), true)}</time></div>;
  })}</div> : <p>尚无研究运行记录。发起真实取证后，成功与失败状态都会保留。</p>}</details>;
}
