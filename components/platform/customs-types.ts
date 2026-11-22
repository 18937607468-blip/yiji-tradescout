export type CustomsMapping = {
  companyName: string; hsCode: string; description: string; country: string;
  date: string; website: string; role: string; supplier: string;
};
export type CustomsFilters = { hsPrefix: string; keyword: string; country: string; dateFrom: string; dateTo: string };
export type CustomsCandidate = {
  key: string; name: string; country: string; website: string; role: string;
  recordCount: number; hsCodes: string[]; descriptions: string[]; dates: string[];
  suppliers: string[]; sourceRows: number[]; warnings: string[];
  identityConflict?: boolean;
  records: Array<{ row: number; hsCode: string; description: string; country: string; date: string; dateRaw: string; role: string; supplier: string; website: string; sourceName: string }>;
};
export type CustomsPreview = {
  headers: string[]; mapping: CustomsMapping;
  summary: { inputRows: number; matchedRows: number; filteredRows: number; invalidRows: number; duplicateRows: number; candidateCount: number };
  candidates: CustomsCandidate[]; errors: Array<{ row: number; code: string; message: string }>;
  previewHash: string; limits: { maxRows: number; maxTextBytes: number }; notice: string;
};
export type CustomsImportSummary = { selectedCompanies: number; importedCompanies: number; mergedCompanies: number; importedRecords: number; duplicateRecords: number; batchId: string };
export const EMPTY_CUSTOMS_MAPPING: CustomsMapping = { companyName: "", hsCode: "", description: "", country: "", date: "", website: "", role: "", supplier: "" };
export const EMPTY_CUSTOMS_FILTERS: CustomsFilters = { hsPrefix: "", keyword: "", country: "", dateFrom: "", dateTo: "" };
