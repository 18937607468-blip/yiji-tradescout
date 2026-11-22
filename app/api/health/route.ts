import { readPlatform } from "@/lib/platform/store.mjs";
import { MODEL } from "@/lib/platform/model-config.mjs";
import { json, withApi } from "@/lib/platform/api";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return withApi(request, async () => {
    const state = await readPlatform();
    const calls = state.runLog.filter((r: { type?: string }) => r.type === "model_call");
    return json({ ok: true, data: { platform: "冠英 B2B 外贸平台", storage: "D1", identity: state.identity, capabilities: state.capabilities, model: MODEL, calls: { attempted: calls.length, validated: calls.filter((c: { status?: string }) => c.status === "validated").length }, checkedAt: new Date().toISOString() } });
  });
}
