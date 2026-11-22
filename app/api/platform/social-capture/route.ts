import { captureSocialSource } from "@/lib/platform/social-capture.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";

export async function POST(request: Request) {
  return withApi(request, async () => {
    const body = await readBody(request, 500000);
    const result = await captureSocialSource(body);
    return json({ ok: true, data: result.state, meta: result.meta });
  });
}
