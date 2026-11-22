import { researchCompany } from "@/lib/platform/research.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";
export async function POST(request: Request) {
  return withApi(request, async () => { const body = await readBody(request, 10000); const { state, meta } = await researchCompany(body.companyId); return json({ ok: true, data: state, meta }); });
}
