import { reviewFinancialReport, saveFinancialReview } from "@/lib/platform/financial-review.mjs";
import { extractFinancialReport } from "@/lib/platform/financial-extract.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";

export async function POST(request: Request) {
  return withApi(request, async () => {
    const body = await readBody(request, 110000);
    if (body.mode === "extract") {
      const result = await extractFinancialReport(body);
      return json({ ok: true, result: result.result, data: result.state });
    }
    if (body.mode === "review") return json({ ok: true, result: await reviewFinancialReport(body) });
    if (body.mode === "save") { const result = await saveFinancialReview(body); return json({ ok: true, data: result.state, meta: result.meta }); }
    return json({ ok: false, error: { code: "FINANCIAL_MODE_REQUIRED", message: "请选择提取、核验或保存操作。" } }, 400);
  });
}
