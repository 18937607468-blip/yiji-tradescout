import type { Evidence } from "./types";
import type { DiscoveryQuery } from "./discovery-types";

export type WebsiteResolutionCriteria = { name: string; country: string };
export type WebsiteResolutionPlan = {
  companyId: string; companyName: string; expectedRevision: number;
  criteria: WebsiteResolutionCriteria; queries: string[]; planHash: string; provider: string;
  marketHint: string; warnings: string[];
  limits: { queries: number; resultsPerQuery: number; inspectPerRun: number; pagesPerCandidate: number; runsPerDay: number; cacheHours: number };
};
export type WebsiteResolutionCandidate = {
  id: string; title: string; url: string; domain: string; searchSnippet: string; sourceQueryIndexes: number[];
  status: "unverified" | "inspecting" | "needs_review" | "needs_evidence" | "blocked";
  evidence: Evidence[];
  identityEvidence: Array<{ sourceId: string; field: "company_name"; quote: string }>;
  contacts: Array<{ type: "email" | "phone" | "url"; value: string; role: string; sourceUrl: string; verification: "public_page" }>;
  warnings: string[]; pagesFetched: number; inspectedAt?: string; candidateHash?: string;
  attachedCompanyId?: string; existingCompanyId?: string;
};
export type WebsiteResolutionRun = {
  sourceKind?: "manual_url";
  id: string; companyId: string; companyName: string; companyRevision: number;
  criteria: WebsiteResolutionCriteria; planHash: string; inputHash: string; provider: string;
  status: "searching" | "complete" | "partial" | "failed"; startedAt: string; finishedAt?: string;
  queries: DiscoveryQuery[]; candidates: WebsiteResolutionCandidate[]; inspectionCount: number; modelCalls: 0;
  notice: string; stats: { returned: number; excluded: number; duplicateDomains: number };
};
export type WebsiteResolutionSearchResult = { run: WebsiteResolutionRun; cached: boolean };
export type WebsiteResolutionInspectResult = { run: WebsiteResolutionRun; candidate: WebsiteResolutionCandidate; cached: boolean };
export type WebsiteResolutionAttachResult = { companyId: string; duplicate: boolean };
