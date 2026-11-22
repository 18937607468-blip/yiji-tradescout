import { act } from "@/lib/platform/domain.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";
export async function POST(request: Request) {
  return withApi(request, async () => { const body = await readBody(request, 100000); return json({ ok: true, data: await act(body.type, body.payload) }); });
}
