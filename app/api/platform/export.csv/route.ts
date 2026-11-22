import { exportCsv } from "@/lib/platform/domain.mjs";
import { readPlatform } from "@/lib/platform/store.mjs";
import { withApi } from "@/lib/platform/api";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return withApi(request, async () => new Response(exportCsv(await readPlatform()), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="guanying-customers.csv"', "Cache-Control": "no-store" } }));
}
