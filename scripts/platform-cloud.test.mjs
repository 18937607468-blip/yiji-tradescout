import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { withPlatformContext } from "../lib/platform/context.mjs";
import { readPlatform, mutatePlatform } from "../lib/platform/store.mjs";
import { act, importCompanies, exportCsv } from "../lib/platform/domain.mjs";
import { saveModelKey, getModelKey, modelConfigStatus, sealKey, unsealKey } from "../lib/platform/model-config.mjs";
import { reserveModelBudget, researchCompany } from "../lib/platform/research.mjs";
import { validatePublicUrl } from "../lib/platform/web.mjs";

async function database() {
  const sql = new DatabaseSync(":memory:");
  for (const file of (await readdir(new URL("../drizzle/", import.meta.url))).filter(f => f.endsWith(".sql")).sort()) sql.exec(await readFile(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  return {
    raw: sql,
    prepare(query) {
      return { bind(...values) {
        return {
          async first() { return sql.prepare(query).get(...values) || null; },
          async run() { const result = sql.prepare(query).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
        };
      }};
    },
  };
}
const testSecret = Buffer.alloc(32, 7).toString("base64url");
function context(db, ownerId, authenticated = true) { return { db, ownerId, authenticated, dataKey: testSecret, displayName: "Synthetic test" }; }

test("Generated D1 schema supports per-account/visitor persistence, revisions and conflict safety", async () => {
  const db = await database();
  try {
    const a = context(db, "u:account-a"), device2 = context(db, "u:account-a"), b = context(db, "u:account-b"), guest = context(db, "v:random-guest", false);
    await withPlatformContext(a, () => act("create_company", { name: "Account A synthetic lead", website: "https://lead.example" }));
    assert.equal((await withPlatformContext(device2, readPlatform)).companies.length, 1);
    assert.equal((await withPlatformContext(b, readPlatform)).companies.length, 0);
    assert.equal((await withPlatformContext(guest, readPlatform)).companies.length, 0);
    const company = (await withPlatformContext(a, readPlatform)).companies[0];
    await withPlatformContext(a, () => act("update_company", { id: company.id, expectedRevision: 1, stage: "已联系" }));
    await assert.rejects(() => withPlatformContext(device2, () => act("update_company", { id: company.id, expectedRevision: 1, owner: "stale edit" })), e => e.code === "REVISION_CONFLICT");
    const imports = await withPlatformContext(a, () => importCompanies("name,website\nFacebook A,https://facebook.com/company-a\nFacebook B,https://facebook.com/company-b"));
    assert.equal(imports.summary.imported, 2);
    const micImports = await withPlatformContext(a, () => importCompanies("name,website\nMIC A,https://www.made-in-china.com/showroom/company-a\nMIC B,https://www.made-in-china.com/showroom/company-b\nMIC A duplicate,https://www.made-in-china.com/showroom/company-a/"));
    assert.equal(micImports.summary.imported, 2);
    assert.equal(micImports.summary.duplicates, 1);
    assert.ok(exportCsv(imports.state).includes("Account A synthetic lead"));
    const simultaneous = await Promise.allSettled([
      withPlatformContext(a, () => mutatePlatform(s => { s.events.push({ id: "CAS-a" }); })),
      withPlatformContext(device2, () => mutatePlatform(s => { s.events.push({ id: "CAS-b" }); })),
    ]);
    assert.equal(simultaneous.filter(v => v.status === "fulfilled").length, 1);
    assert.equal(simultaneous.filter(v => v.status === "rejected" && v.reason.code === "WORKSPACE_CONFLICT").length, 1);
  } finally { db.raw.close(); }
});

test("Keys are encrypted at rest, bound to owner, never returned, and unavailable to guests", async () => {
  const db = await database();
  try {
    const a = context(db, "u:key-owner"), b = context(db, "u:another"), guest = context(db, "v:guest", false);
    const fakeKey = "synthetic-not-a-real-provider-key";
    const status = await withPlatformContext(a, () => saveModelKey(fakeKey));
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes(fakeKey), false);
    const stored = db.raw.prepare("SELECT * FROM model_config WHERE owner_id = ?").get(a.ownerId);
    assert.notEqual(stored.ciphertext, fakeKey); assert.equal(JSON.stringify(stored).includes(fakeKey), false);
    assert.equal(await withPlatformContext(a, getModelKey), fakeKey);
    assert.equal((await withPlatformContext(b, modelConfigStatus)).configured, false);
    await assert.rejects(() => withPlatformContext(b, getModelKey), e => e.code === "MODEL_NOT_CONFIGURED");
    await assert.rejects(() => withPlatformContext(guest, () => saveModelKey(fakeKey)), e => e.code === "SIGN_IN_REQUIRED");
    await assert.rejects(() => withPlatformContext(guest, getModelKey), e => e.code === "SIGN_IN_REQUIRED");
    const sealed = await sealKey(fakeKey, testSecret, a.ownerId);
    await assert.rejects(() => unsealKey(sealed, testSecret, b.ownerId), e => e.code === "KEY_CONFIG_UNREADABLE");
  } finally { db.raw.close(); }
});

test("Memory remains scoped and reviewable; budget is durable and counts calls without a daily application limit", async () => {
  const db = await database();
  try {
    const a = context(db, "u:memory-owner");
    await withPlatformContext(a, async () => {
      let state = await act("create_company", { name: "Memory synthetic lead" });
      const id = state.companies[0].id;
      await act("propose_memory", { companyId: id, inquiryId: "one", occurredAt: "2026-11-21T09:00:00Z", sourceText: "Please confirm the lead time.", patch: { nextAction: "确认交期" } });
      state = await readPlatform();
      await act("apply_memory", { companyId: id, proposalId: state.companies[0].memoryProposals[0].id });
      await act("propose_memory", { companyId: id, inquiryId: "one", occurredAt: "2026-11-20T09:00:00Z", sourceText: "Old instruction.", patch: { nextAction: "旧安排" } });
      state = await readPlatform();
      await assert.rejects(() => act("apply_memory", { companyId: id, proposalId: state.companies[0].memoryProposals[1].id }), e => e.code === "STALE_MEMORY");
      for (let n = 0; n < 10; n++) await reserveModelBudget(id, "test-run-" + n, "synthetic-hash");
      await reserveModelBudget(id, "eleventh-run", "synthetic-hash");
      assert.equal((await readPlatform()).runLog.length, 11);
    });
    assert.equal((await withPlatformContext(context(db, "u:other-account"), readPlatform)).runLog.length, 0);
  } finally { db.raw.close(); }
});

test("Restricted platforms and private URLs fail before fetch, without losing prior evidence", async () => {
  for (const url of ["http://127.0.0.1", "http://169.254.169.254/latest/meta-data", "http://localhost", "https://figeon.hqsmartcloud.com", "https://admin.hqsmartcloud.com"]) assert.throws(() => validatePublicUrl(url));
  const db = await database();
  try {
    await withPlatformContext(context(db, "v:test-visitor", false), async () => {
      let state = await act("create_company", { name: "Blocked URL fixture", website: "http://127.0.0.1" });
      const id = state.companies[0].id;
      await mutatePlatform(s => { s.companies[0].evidence.push({ id: "old", type: "webpage", snippet: "Old source fixture" }); });
      await assert.rejects(() => researchCompany(id), e => e.code === "UNSAFE_URL");
      state = await readPlatform();
      assert.equal(state.companies[0].researchStatus, "failed");
      assert.equal(state.companies[0].evidence[0].id, "old");
      assert.equal(state.companies[0].researchLock, null);
      assert.equal(state.runLog.filter(r => r.type === "model_call").length, 0);
    });
  } finally { db.raw.close(); }
});
