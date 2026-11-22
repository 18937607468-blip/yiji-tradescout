import { checkInquiryAssurance } from "@/lib/platform/inquiries.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";

export async function POST(request: Request) {
  return withApi(request, async () => {
    const body = await readBody(request, 12000);
    return json({ ok: true, result: await checkInquiryAssurance(body) });
  });
}
