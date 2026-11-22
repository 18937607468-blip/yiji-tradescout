import { readPlatform } from "@/lib/platform/store.mjs";
import { json, withApi } from "@/lib/platform/api";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return withApi(request, async () => json({ ok: true, data: await readPlatform() })); }
