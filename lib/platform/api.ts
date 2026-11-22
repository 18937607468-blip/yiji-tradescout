import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { createHash, randomBytes } from "node:crypto";
import { withPlatformContext } from "./context.mjs";
import { readPlatform } from "./store.mjs";
import { PlatformError } from "./domain.mjs";

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
export async function readBody(request: Request, limit = 2300000) {
  if (Number(request.headers.get("content-length") || 0) > limit) throw new PlatformError("BODY_TOO_LARGE", "请求超过允许大小。", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit) throw new PlatformError("BODY_TOO_LARGE", "请求超过允许大小。", 413);
  try { return JSON.parse(text); } catch { throw new PlatformError("INVALID_JSON", "请求格式无效。"); }
}
export async function withApi(request: Request, operation: () => Promise<Response>) {
  if (!["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return json({ ok: false, error: { code: "ORIGIN_REJECTED", message: "请在当前网站内提交操作。" } }, 403);
  }
  if (!env.DB) return json({ ok: false, error: { code: "STORAGE_NOT_READY", message: "在线数据库尚未连接，请稍后再试。" } }, 503);
  const user = await getChatGPTUser();
  const cookieName = "__Host-guanying_session";
  const supplied = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  const visitor = /^[a-f0-9]{64}$/.test(supplied || "") ? supplied! : randomBytes(32).toString("hex");
  const ownerId = user ? "u:" + user.userId : "v:" + createHash("sha256").update(visitor).digest("hex");
  const context = { db: env.DB, ownerId, authenticated: !!user, displayName: user?.displayName, dataKey: env.APP_DATA_KEY };
  const response = await withPlatformContext(context, async () => {
    try { return await operation(); }
    catch (error) {
      const value = error as Error & { code?: string; status?: number; includeState?: boolean; publicError?: boolean };
      const known = value instanceof PlatformError || value.publicError;
      const schema = value.name === "ZodError";
      const data = known && value.includeState ? await readPlatform().catch(() => undefined) : undefined;
      return json({ ok: false, error: { code: known ? value.code : schema ? "INVALID_FIELDS" : "OPERATION_FAILED",
        message: known ? value.message : schema ? "字段缺失或格式不正确，请核对输入。" : "本次操作未完成；没有用示例结果替代。" }, ...(data ? { data } : {}) }, known ? value.status || 400 : schema ? 400 : 500);
    }
  });
  if (!user && visitor !== supplied) response.headers.append("Set-Cookie", cookieName + "=" + visitor + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800");
  return response;
}
