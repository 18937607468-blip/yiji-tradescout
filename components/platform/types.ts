import type { CommitmentRecord, InquiryRecord } from "./inquiry-types";
import type { WebsiteResolutionRun } from "./company-website-types";
export type ModelBudget = { dailyLimit: null; used: number; remaining: null; unlimited: true; date: string; timezone: "Asia/Shanghai"; allowedLimits: number[] };
export type ModelCallSummary = {
  id: string; purpose: "research" | "inquiry" | "financial" | "connection_verification"; provider: "B1X";
  requestedModel: string; responseModel: string | null; requestId: string | null; completionId: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null;
  startedAt: string; finishedAt: string | null; durationMs: number | null; status: string;
  connectionSucceeded: boolean; businessValidated: boolean | null; errorCode: string | null; statusCode: number | null; configSavedAt: string | null;
};
export type ModelConnectionStatus = {
  configured: boolean; authenticated: boolean; storageReady: boolean; provider: "B1X"; model: string; baseURL: string;
  configSavedAt: string | null; currentConfigVerified: boolean; verifiedAt: string | null;
  budget: ModelBudget; lastAttempt: ModelCallSummary | null; lastSuccessfulCall: ModelCallSummary | null;
};
export type Grade = "A" | "B" | "C" | "unknown";
export type Section = "acquisition" | "inquiries" | "customers" | "products" | "followups" | "settings";
export type Evidence = {
  id: string;
  type: "webpage" | "manual" | "document";
  url?: string;
  title?: string;
  snippet: string;
  capturedAt?: string;
  status: "observed" | "reported" | "inferred";
};
export type Communication = {
  id: string;
  text: string;
  occurredAt: string;
  recordedAt?: string;
  dataClass?: "real" | "synthetic";
};
export type MemoryProposal = {
  id: string;
  status: "pending" | "applied" | "stale" | "cancelled";
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  occurredAt?: string;
  createdAt?: string;
  appliedAt?: string;
  sourceText?: string;
  reason?: string;
};
export type Company = {
  id: string;
  name: string;
  website?: string;
  market?: string;
  productRefs?: string[];
  buyerRole?: string;
  grade?: Grade;
  missingEvidence?: string[];
  stage?: string;
  owner?: string;
  nextAction?: string;
  nextFollowUpAt?: string;
  lastContactAt?: string;
  notes?: string;
  sourceUrl?: string;
  sourceKind?: string;
  isDemo?: boolean;
  dataClass?: string;
  demo?: boolean;
  evidence?: Evidence[];
  communications?: Communication[];
  memoryProposals?: MemoryProposal[];
  lossReason?: string;
  nextScreeningSuggestion?: { status?: string; text: string; sourceProposalId?: string; createdAt?: string };
  websiteFacts?: Array<{ field: string; value: string; sourceId: string; quote: string; classification?: string }>;
  researchProductMatches?: Array<{ productId: string; relationship: string; sourceId: string; quote: string }>;
  openingQuestionEvidence?: { text: string; sourceId: string; quote: string } | null;
  suggestedNextAction?: string;
  contacts?: Array<{ type: string; value: string; role?: string; sourceUrl?: string; verification?: string }>;
  researchStatus?: "not_started" | "complete" | "evidence_only" | "failed";
  researchError?: string;
  lastQuestion?: string;
  revision?: number;
};
export type Product = {
  id: string;
  name: string;
  category: string;
  codes: Array<{ namespace: string; value: string }>;
  source?: string;
  notes?: string;
  imageUrl?: string;
};
export type Task = {
  id: string;
  companyId: string;
  title: string;
  dueAt: string;
  owner?: string;
  status: "open" | "done";
};
export type PlatformEvent = {
  id: string;
  companyId?: string;
  type?: string;
  title?: string;
  summary?: string;
  text?: string;
  createdAt?: string;
  occurredAt?: string;
  [key: string]: unknown;
};
export type PlatformState = {
  websiteResolutionRuns: WebsiteResolutionRun[];
  discoveryRuns: Array<Record<string, unknown>>;
  financialReviews: Array<Record<string, unknown>>;
  socialSources: Array<Record<string, unknown>>;
  customsBatches: Array<Record<string, unknown>>;
  customsRecords: Array<Record<string, unknown>>;
  commitmentRecords: CommitmentRecord[];
  supplyReferences: Array<Record<string, unknown>>;
  inquiries: InquiryRecord[];
  fitmentRelations: Array<Record<string, unknown>>;
  quoteHistory: Array<Record<string, unknown>>;
  fitmentCatalog: Array<Record<string, unknown>>;
  companies: Company[];
  products: Product[];
  events: PlatformEvent[];
  tasks: Task[];
  capabilities: { modelConfigured: boolean; searchConfigured: boolean; websiteFetch?: boolean; modelKeyStorageAvailable?: boolean };
  identity?: { authenticated: boolean; displayName?: string; storage: "account" | "anonymous" };
  updatedAt?: string;
  runLog: Array<Record<string, unknown>>;
};
export const EMPTY_STATE: PlatformState = {
  websiteResolutionRuns: [],
  discoveryRuns: [],
  financialReviews: [],
  socialSources: [],
  customsBatches: [], customsRecords: [],
  companies: [], products: [], events: [], tasks: [], inquiries: [], fitmentRelations: [], quoteHistory: [], fitmentCatalog: [], commitmentRecords: [], supplyReferences: [],
  capabilities: { modelConfigured: false, searchConfigured: false }, runLog: [],
};
export const STAGES = ["待研究", "待联系", "已联系", "需求确认", "报价沟通", "样品沟通", "成交/维护", "暂停"];
export const GRADE_LABELS: Record<Grade, string> = { A: "A · 优先跟进", B: "B · 值得开发", C: "C · 暂缓投入", unknown: "待补证" };
export const safeUrl = (value?: string) => {
  if (!value) return undefined;
  try { const url = new URL(value.includes("://") ? value : `https://${value}`); return ["http:", "https:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
};
export const hostname = (value?: string) => {
  try { return new URL(safeUrl(value) || "").hostname.replace(/^www\./, ""); } catch { return value || "官网待补充"; }
};
export const formatDate = (value?: string, withTime = false) => {
  if (!value) return "未安排";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期待确认";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(date);
};
export const localInputDate = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const workday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
export const isToday = (value?: string) => !!value && Number.isFinite(Date.parse(value)) && workday.format(new Date(value)) === workday.format(new Date());
export const isOverdue = (value?: string) => !!value && new Date(value).getTime() < Date.now();
export const isDemoCompany = (company: Company) => !!company.isDemo || !!company.demo || company.dataClass === "synthetic" || company.sourceKind === "demo" || company.sourceKind === "seed";
