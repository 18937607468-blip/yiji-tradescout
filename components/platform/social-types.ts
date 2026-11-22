export type SocialChannel = "视频号" | "微信" | "Facebook" | "WhatsApp" | "MIC" | "其他";
export type SocialDataClass = "real" | "synthetic";
export type SocialAttachment = {
  dataUrl: string; fileName: string; mime: "image/jpeg" | "image/png" | "image/webp";
  originalSha256: string; originalSize: number; width: number; height: number;
  storedBytes: number; compressed: true; storedSha256?: string;
};
export type SocialSource = {
  id: string; revision: number; channel: SocialChannel; handle?: string;
  captureMethod: "paste" | "text_file" | "screenshot"; sourceName: string; sourceUrl?: string;
  occurredAt?: string; occurredAtPrecision?: "date" | "datetime"; occurredAtRaw?: string; text: string; authorized: boolean; dataClass: SocialDataClass;
  companyId?: string; companyConfirmed?: boolean; attachment?: SocialAttachment;
  contentHash?: string; createdAt: string; updatedAt?: string;
  status: "pending_company" | "linked"; ocrPerformed: false; synced: false;
  history?: Array<Record<string, unknown>>;
};
export type SocialSaveMeta = { id: string; duplicate: boolean; linked: boolean; companyId?: string; revision: number; notice: string };
