import { planBuyerDiscovery, searchMoreBuyers, inspectBuyerCandidate, reassessBuyerCandidate, saveBuyerCandidate } from "@/lib/platform/buyer-discovery.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";

export async function POST(request: Request) {
  return withApi(request, async () => {
    const body = await readBody(request, 10000);
    if (body.mode === "plan") return json({ ok: true, result: await planBuyerDiscovery(body) });
    if (body.mode === "search") { const value = await searchMoreBuyers(body); return json({ ok: true, result: value.result, data: value.state }); }
    if (body.mode === "inspect") { const value = await inspectBuyerCandidate(body); return json({ ok: true, result: value.result, data: value.state }); }
    if (body.mode === "reassess") { const value = await reassessBuyerCandidate(body); return json({ ok: true, result: value.result, data: value.state }); }
    if (body.mode === "save") { const value = await saveBuyerCandidate(body); return json({ ok: true, result: value.result, data: value.state }); }
    return json({ ok: false, error: { code: "DISCOVERY_MODE_REQUIRED", message: "请选择搜索条件预览、搜索、核验或保存操作。" } }, 400);
  });
}
