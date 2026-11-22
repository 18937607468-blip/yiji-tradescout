import { extractInquiry } from "@/lib/platform/inquiry-extract.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return withApi(request, async () => {
    const body = await readBody(request, 80000);
    const { result, state } = await extractInquiry(body);
    return json({ ok: true, result, data: state });
  });
}
