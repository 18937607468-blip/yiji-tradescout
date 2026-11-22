import { importCompanies } from "@/lib/platform/domain.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";
export async function POST(request: Request) {
  return withApi(request, async () => { const body = await readBody(request); const { state, summary } = await importCompanies(body.csv); return json({ ok: true, data: state, meta: summary }); });
}
