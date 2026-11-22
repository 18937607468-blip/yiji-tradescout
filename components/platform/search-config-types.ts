export type SearchVerification = {
  status: "succeeded" | "failed";
  checkedAt: string;
  configSavedAt: string | null;
  httpStatus?: number;
  requestId?: string;
  resultCount?: number;
  credits?: number;
  errorCode?: string;
  message?: string;
  retryAfterSeconds?: number;
};

export type SearchConfigStatus = {
  authenticated: boolean;
  configured: boolean;
  storageReady: boolean;
  provider: "Tavily";
  authMode: "keyed" | "unconfigured";
  configSavedAt: string | null;
  lastVerification: SearchVerification | null;
};
