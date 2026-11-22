import { createHash } from "node:crypto";
import { PlatformError } from "./domain.mjs";

const manualOnlyDomains = ["facebook.com", "linkedin.com", "instagram.com", "alibaba.com", "made-in-china.com", "52wmb.com", "tradesns.com", "tendata.com", "tendata.cn", "volza.com", "panjiva.com", "importgenius.com", "importyeti.com", "hqsmartcloud.com"];
export function validatePublicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new PlatformError("INVALID_URL", "官网网址无效。"); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new PlatformError("UNSAFE_URL", "仅允许公开 HTTP(S) 官网和标准端口。");
  if (!host.includes(".") || /(^|\.)localhost$|\.local$|\.internal$|\.invalid$/.test(host) || host.includes(":")) throw new PlatformError("UNSAFE_URL", "不能访问本机、内网或保留地址。");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a,b,c] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113)) throw new PlatformError("UNSAFE_URL", "目标是内网或保留地址。");
  }
  if (manualOnlyDomains.some(d => host === d || host.endsWith("." + d))) throw new PlatformError("MANUAL_SOURCE_REQUIRED", "该平台需要在授权页面人工检索，再导入确认后的企业官网；本站不会代取登录或受限内容。", 422);
  return url;
}
export async function fetchPublicPage(value, redirects = 0, deadline = Date.now() + 12000) {
  if (redirects > 3) throw new PlatformError("TOO_MANY_REDIRECTS", "官网跳转过多。", 502);
  const url = validatePublicUrl(value);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new PlatformError("WEBSITE_TIMEOUT", "官网读取超时，没有生成替代材料。", 504);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { Accept: "text/html,text/plain;q=0.9" } });
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new PlatformError("INVALID_REDIRECT", "官网跳转缺少目标地址。", 502);
      return await fetchPublicPage(new URL(location, url).href, redirects + 1, deadline);
    }
    if (!response.ok) { await response.body?.cancel(); throw new PlatformError("WEBSITE_HTTP_ERROR", "官网返回 HTTP " + response.status + "。未尝试绕过访问限制，请人工导入授权资料。", 502); }
    if (!/text\/(?:html|plain)|application\/xhtml\+xml/i.test(response.headers.get("content-type") || "")) { await response.body?.cancel(); throw new PlatformError("UNSUPPORTED_CONTENT", "本阶段只读取公开 HTML 网页；其他材料请人工核验并录入。", 415); }
    const reader = response.body?.getReader();
    if (!reader) throw new PlatformError("EMPTY_WEBSITE", "官网没有返回可读内容。", 502);
    const chunks = []; let bytes = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      bytes += chunk.byteLength;
      if (bytes > 1200000) { await reader.cancel(); throw new PlatformError("PAGE_TOO_LARGE", "网页超过读取上限。", 413); }
      chunks.push(chunk);
    }
    const all = new Uint8Array(bytes); let position = 0;
    for (const chunk of chunks) { all.set(chunk, position); position += chunk.length; }
    const html = new TextDecoder().decode(all);
    return { url: url.href, status: response.status, html, text: htmlToText(html), title: htmlToText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url.hostname).slice(0, 200) };
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError(controller.signal.aborted ? "WEBSITE_TIMEOUT" : "WEBSITE_UNAVAILABLE", "官网网络请求未成功；未产生模拟原文，可导入已授权资料。", 502);
  } finally { clearTimeout(timer); }
}

function decodeEntities(value) {
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
    const n = /^x/i.test(code) ? parseInt(code.slice(1), 16) : Number(code);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
  }).replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}
export function htmlToText(html) {
  return decodeEntities(String(html).replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/(?:p|div|li|h[1-6]|section|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
export function relatedPages(html, baseUrl) {
  const base = new URL(baseUrl);
  const host = base.hostname.replace(/^www\./, "");
  const candidates = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decodeEntities(match[1]), base);
      if (!["http:", "https:"].includes(url.protocol) || url.hostname.replace(/^www\./, "") !== host || url.href === base.href) continue;
      url.hash = "";
      const label = htmlToText(match[2]).slice(0, 100) + " " + url.pathname;
      const score = /contact|yhteystiedot|kontakt|联系我们|contacto/i.test(label) ? 4
        : /brake|friction|制动|刹车/i.test(label) ? 3
        : /about|meista|company|关于/i.test(label) ? 2
        : /product|catalog|产品/i.test(label) ? 1 : 0;
      if (score) candidates.push({ url: url.href, score });
    } catch { /* Ignore malformed document links. */ }
  }
  const ranked = [...new Map(candidates.sort((a, b) => b.score - a.score).map(c => [c.url, c])).values()];
  const product = ranked.find(c => c.score === 3) || ranked.find(c => c.score === 1);
  const contact = ranked.find(c => c.score === 4);
  const selected = [product, contact].filter(Boolean);
  // Preserve the three-page cap, but do not let two contact links consume both research slots.
  for (const candidate of ranked) if (selected.length < 2 && !selected.some(c => c.url === candidate.url) && !(candidate.score === 4 && contact)) selected.push(candidate);
  return selected.slice(0, 2).map(c => c.url);
}
export function publicContacts(page) {
  const entries = new Map();
  for (const match of page.html.matchAll(/href\s*=\s*["'](mailto:|tel:|https?:\/\/(?:wa\.me\/|api\.whatsapp\.com\/)[^"']*)([^"']*)["']/gi)) {
    const raw = decodeEntities(match[1] + match[2]);
    if (/^mailto:/i.test(raw)) {
      const value = raw.slice(7).split("?")[0].trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) entries.set("email:" + value.toLowerCase(), { type: "email", value });
    } else if (/^tel:/i.test(raw)) {
      const value = raw.slice(4).trim();
      const digits = value.replace(/\D/g, "");
      if (/^[+\d\s().-]+$/.test(value) && digits.length >= 7 && digits.length <= 15) entries.set("phone:" + value, { type: "phone", value });
    } else {
      try {
        const link = new URL(raw);
        const digits = link.hostname === "wa.me" ? link.pathname.slice(1) : link.searchParams.get("phone") || "";
        if (/^\+?\d{7,15}$/.test(digits)) entries.set("url:" + raw, { type: "url", value: raw });
      } catch { /* Invalid public contact links are not saved as usable contacts. */ }
    }
  }
  return [...entries.values()].slice(0, 20).map(entry => ({
    ...entry, sourceUrl: page.url, verification: "public_page",
    role: "公开联系入口；岗位未确认",
  }));
}
export function pageEvidence(page) {
  return {
    id: "web-" + createHash("sha256").update(page.url + "\n" + page.text).digest("hex").slice(0, 16),
    type: "webpage", url: page.url, title: page.title, snippet: page.text.slice(0, 12000),
    capturedAt: new Date().toISOString(), status: "observed", contentHash: createHash("sha256").update(page.text).digest("hex"),
  };
}
