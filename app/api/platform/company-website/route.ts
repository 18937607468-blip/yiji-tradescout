import { planCompanyWebsite, searchCompanyWebsite, inspectCompanyWebsite, inspectCompanyWebsiteUrl, attachCompanyWebsite } from "@/lib/platform/company-website.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";

export async function POST(request: Request) {
  return withApi(request, async () => {
    const body = await readBody(request, 6000);
    if (body.mode === "plan") return json({ ok: true, result: await planCompanyWebsite(body) });
    if (body.mode === "search") { const value = await searchCompanyWebsite(body); return json({ ok: true, result: value.result, data: value.state }); }
    if (body.mode === "inspect") { const value = await inspectCompanyWebsite(body); return json({ ok: true, result: value.result, data: value.state }); }
    if (body.mode === "inspect_url") { const value = await inspectCompanyWebsiteUrl(body); return json({ ok: true, result: value.result, data: value.state }); }
    if (body.mode === "attach") { const value = await attachCompanyWebsite(body); return json({ ok: true, result: value.result, data: value.state }); }
    return json({ ok: false, error: { code: "INVALID_MODE", message: "请选择预览、搜索、读取官网或确认补入。" } }, 400);
  });
}
