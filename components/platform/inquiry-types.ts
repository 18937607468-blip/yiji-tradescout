export type InquiryInputs = {
  vehicleModel: string; axleBrand: string; axleModel: string; year: string;
  brakeSystem: string; partType: string; loadTons: string; partCode: string;
  codeNamespace: string; widthMm: string; thicknessMm: string; drumDiameterMm: string;
  photoUrl: string; materialGrade: string; quantity: string; unit: string;
  currency: string; incoterm: string; destination: string; accessories: string;
  rawWidth: string; rawThickness: string; sizeCode: string; dimensionUnitConfirmed: boolean;
};
export const EMPTY_INQUIRY_INPUTS: InquiryInputs = {
  vehicleModel: "", axleBrand: "", axleModel: "", year: "", brakeSystem: "",
  partType: "unknown", loadTons: "", partCode: "", codeNamespace: "unknown",
  widthMm: "", thicknessMm: "", drumDiameterMm: "", photoUrl: "", materialGrade: "",
  quantity: "", unit: "", currency: "", incoterm: "", destination: "", accessories: "",
  rawWidth: "", rawThickness: "", sizeCode: "", dimensionUnitConfirmed: false,
};
export type FitmentEvidence = { title?: string; url?: string; page?: string | number; quote?: string };
export type FitmentCandidate = {
  id: string; partNumber: string; namespace: string; name?: string; manufacturer?: string;
  kind?: "oem" | "company"; partType?: string; evidence?: FitmentEvidence[];
  dimensions?: Record<string, string | number | null>; missing?: string[]; reasons?: string[];
  dimensionsRaw?: Record<string, string | number | null>;
  status?: string; note?: string; codes?: Array<{ namespace: string; value: string }>;
  aliases?: Array<{ namespace: string; code: string }>;
};
export type QuoteRange = {
  candidateId?: string; partNumber?: string; namespace?: string; status?: string;
  min?: number; max?: number; currency?: string; unit?: string;
  incoterm?: string; count?: number; sourceCount?: number; sources?: unknown[];
  note?: string; reason?: string; missing?: string[];
  label?: string; sourceTitle?: string; sourceUrl?: string; referenceIds?: string[];
  validUntil?: string;
};
export type InquiryAnalysis = {
  candidates: FitmentCandidate[]; excluded?: Array<{ id?: string; partNumber?: string; reasons?: string[]; reason?: string }>;
  relatedCatalogue?: FitmentCandidate[];
  totalCandidates?: number; missing?: string[]; questions?: string[]; quoteRanges?: QuoteRange[];
  status?: string; elapsedMs?: number; engineVersion?: string;
  inputFingerprint?: string;
  trace?: Array<Record<string, unknown>>; message?: string; notice?: string;
};
export type InquiryRecord = {
  id: string; companyId: string; title?: string; channel?: string; revision: number;
  status?: string; sourceText?: string; sourceUrl?: string; owner?: string;
  nextFollowUpAt?: string; followUpAt?: string; dataClass?: "real" | "synthetic";
  inputs: InquiryInputs; analysis: InquiryAnalysis;
  materialCalculations?: MaterialCalculationRecord[];
  history?: Array<Record<string, unknown>>; createdAt?: string; updatedAt?: string;
};

export type MaterialLengthUnit = "mm" | "cm" | "m" | "in";
export type MaterialDensityUnit = "g/cm3" | "kg/m3";
export type MaterialPriceUnit = "kg" | "g" | "tonne" | "lb";
export type MaterialMeasure<Unit extends string> = { value: string; unit: Unit; displayUnit?: Unit };
export type MaterialCostInputs = {
  outerArc: MaterialMeasure<MaterialLengthUnit>; width: MaterialMeasure<MaterialLengthUnit>;
  thickness1: MaterialMeasure<MaterialLengthUnit>; thickness2: MaterialMeasure<MaterialLengthUnit>;
  density: MaterialMeasure<MaterialDensityUnit>; adjustmentFactor: string;
  materialPrice: { value: string; per: MaterialPriceUnit; displayPer?: MaterialPriceUnit; currency: string; sourceText: string };
  order: { quantity: string; unit: "piece" | "set"; piecesPerSet: string }; note: string;
};
export type MaterialCostCalculation = {
  formulaVersion: string; inputs: MaterialCostInputs;
  normalized: { outerArcMm: number; widthMm: number; thickness1Mm: number; thickness2Mm: number; averageThicknessMm: number; densityGPerCm3: number; adjustmentFactor: number; materialPricePerKg: number; currency: string; quantity: number | null; piecesPerSet: number | null; pieceQuantity: number | null };
  result: { volumeMm3: number; theoreticalMassKg: number; adjustedMassKg: number; materialPerPiece: number; materialTotal: number | null; pieceQuantity: number | null; currency: string };
  steps: Array<{ key: string; label: string; expression: string; value: number | null; unit: string }>;
  warnings: string[];
};
export type MaterialCalculationRecord = MaterialCostCalculation & {
  id: string; clientRequestId: string; inquiryBasisHash: string; sourceCandidateId: string;
  sourceSnapshot: {
    inquiry: { companyId: string; id: string; dataClass: "real" | "synthetic"; inputs: InquiryInputs; sourceText: string; sourceUrl?: string };
    catalogue: FitmentCandidate | null; formula: string; materialPriceSourceText: string;
  };
  assumptions: string[]; dataClass: "real" | "synthetic"; createdAt: string; recordedBy: string; stale: boolean;
};

export type CommitmentAssessment = {
  status: "ready_for_review" | "blocked";
  blockers: string[];
  evidence: Array<{ id: string; type: string; title: string; quote?: string; url?: string; observedAt?: string }>;
  inputFingerprint: string; sourceFingerprint: string;
  kind: "reply_update" | "dispatch" | "price_reference";
  companyId: string; inquiryId: string; inquiryRevision: number;
  candidateId?: string; dueAt?: string; owner: string; checkedAt: string; notice?: string;
};
export type CommitmentRecord = {
  id: string; companyId: string; inquiryId: string;
  kind: CommitmentAssessment["kind"]; candidateId?: string; dueAt?: string; owner: string;
  sourceText?: string; sourceUrl?: string; sourceFingerprint: string; inputFingerprint: string;
  inquiryRevision: number; reviewed: boolean; dataClass: string; createdAt: string;
  assessment: CommitmentAssessment; currentAssessment?: CommitmentAssessment; needsRecheck?: boolean;
};
