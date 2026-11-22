import { readPlatform } from "@/lib/platform/store.mjs";
import { inquiryCsv } from "@/lib/platform/inquiry-export.mjs";
import { withApi } from "@/lib/platform/api";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return withApi(request, async () => new Response(inquiryCsv(await readPlatform()), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="guanying-inquiries.csv"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  }));
}
