export type FinancialDataClass = "real" | "synthetic";
export type FinancialReport = {
  entityName: string;
  entityRelation: "customer" | "parent_group" | "other" | "unknown";
  scope: "standalone" | "consolidated" | "unknown";
  balanceDate: string; periodStart: string; periodEnd: string;
  currency: string; scale: string;
  currentAssets: string; currentLiabilities: string;
  operatingCashFlow: string; netIncome: string;
};
export type FinancialNumberField = "currentAssets" | "currentLiabilities" | "operatingCashFlow" | "netIncome";
export type FinancialExtractionField = { field: Exclude<keyof FinancialReport, "entityRelation">; value: string; quote: string; basisQuote?: string };
export type FinancialExtraction = {
  fields: FinancialExtractionField[]; unknowns: string[]; model: string;
  requestId?: string | null; usage?: Record<string, unknown>; sourceHash: string;
  elapsedMs: number; status: "pending_review";
};
export type FinancialMetric = { value: string | null; status?: string; formula?: string; currency?: string; scale?: string; baseValue?: string | null };
export type FinancialReviewResult = {
  status: "reviewed" | "incomplete"; report: FinancialReport;
  metrics: { currentRatio: FinancialMetric; workingCapital: FinancialMetric; operatingCashFlow: FinancialMetric; netIncome: FinancialMetric };
  missing: string[]; warnings: string[]; reviewHash: string; sourceHash: string;
  companyId: string; companyName: string; appliesToCustomer: boolean; notice: string;
};
export type FinancialSavedRecord = {
  id: string; companyId: string; report: FinancialReport; sourceText: string;
  sourceName: string; sourcePage: string; sourceUrl?: string; dataClass: FinancialDataClass;
  reviewer: string; confirmations: { identity: boolean; basis: boolean };
  reviewHash: string; sourceHash: string; result: FinancialReviewResult; createdAt: string;
};
export type FinancialSaveMeta = { id: string; duplicate: boolean };
