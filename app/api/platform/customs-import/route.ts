import { previewCustomsImport, importCustomsSelection } from "@/lib/platform/customs-import.mjs";
import { readBody, json, withApi } from "@/lib/platform/api";

export async function POST(request: Request) {
  return withApi(request, async () => {
    const body = await readBody(request, 2000000);
    if (body.mode === "preview") return json({ ok: true, result: previewCustomsImport(body) });
    if (body.mode === "import") {
      const result = await importCustomsSelection(body);
      return json({ ok: true, data: result.state, meta: result.summary });
    }
    return json({ ok: false, error: { code: "CUSTOMS_MODE_REQUIRED", message: "请选择预览或导入操作。" } }, 400);
  });
}
