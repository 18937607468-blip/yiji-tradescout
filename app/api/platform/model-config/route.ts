import { modelConfigStatus, saveModelKey, removeModelKey, updateModelBudget, verifyModelConnection } from "@/lib/platform/model-config.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return withApi(request, async () => json({ ok: true, data: await modelConfigStatus() })); }
export async function POST(request: Request) { return withApi(request, async () => {
  const body = await readBody(request, 4096);
  if (body.mode === "set_budget") return json({ ok: true, data: await updateModelBudget(body.dailyLimit) });
  if (body.mode === "verify_connection") return json({ ok: true, data: await verifyModelConnection() });
  if (!body.mode || body.mode === "save") return json({ ok: true, data: await saveModelKey(body.key) });
  return json({ ok: false, error: { code: "MODEL_CONFIG_MODE", message: "请选择保存配置、设置预算或验证连接。" } }, 400);
}); }
export async function DELETE(request: Request) { return withApi(request, async () => json({ ok: true, data: await removeModelKey() })); }
