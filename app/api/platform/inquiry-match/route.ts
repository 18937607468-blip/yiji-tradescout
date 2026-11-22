import { matchCurrentInquiry } from "@/lib/platform/inquiries.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";

export async function POST(request: Request) {
  return withApi(request, async () => {
    const body = await readBody(request, 20000);
    const result = await matchCurrentInquiry(body.inputs, { companyId: body.companyId, inquiryId: body.inquiryId, dataClass: body.dataClass || "real" });
    return json({ ok: true, result });
  });
}
