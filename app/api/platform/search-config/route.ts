import { searchConfigStatus, saveSearchKey, verifySearchConnection } from "@/lib/platform/search-config.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return withApi(request, async () => json({ ok: true, data: await searchConfigStatus() })); }
export async function POST(request: Request) { return withApi(request, async () => {
  const body = await readBody(request, 4096);
  if (body.mode === "save") return json({ ok: true, data: await saveSearchKey(body.key) });
  if (body.mode === "verify_connection") return json({ ok: true, data: await verifySearchConnection() });
  return json({ ok: false, error: { code: "SEARCH_CONFIG_MODE", message: "请选择保存 Tavily 搜索配置或验证连接。" } }, 400);
}); }
