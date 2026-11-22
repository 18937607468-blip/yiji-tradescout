import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { previewCustomsImport, importCustomsSelection } from "../lib/platform/customs-import.mjs";
import { withPlatformContext } from "../lib/platform/context.mjs";
import { readRaw, mutatePlatform } from "../lib/platform/store.mjs";
import { act } from "../lib/platform/domain.mjs";

const base = { authorized: true, sourceName: "Synthetic customs export.csv", dataClass: "synthetic" };
const csv = "Company,Country,HS Code,Description,Date,Role,Supplier,Website,Quantity\nACME PARTS,UK,8708.30,Truck brake lining,2026-11-01,Importer,Factory A,https://acme.example,100\nACME PARTS,UK,8708.30,Truck brake lining,2026-11-01,Importer,Factory A,https://acme.example,100\nACME PARTS,UK,8708.30,Truck brake lining,2026-11-01,Importer,Factory A,https://acme.example,200\nACME PARTS,US,870830,Truck brake lining,2026-11-02,Freight forwarder,Factory B,,300\nCAR ONLY,UK,870899,Passenger car lamps,2026-11-02,,Factory C,,50\nUNPARSED,UK,870830,Truck brake lining,11/02/2026,,Factory C,,50";
const filtered = { ...base, text: csv, filters: { hsPrefix: "8708.30", keyword: "brake lining", country: "UK", dateFrom: "2026-11-01", dateTo: "2026-11-30" } };

test("CSV原字段映射与AND筛选；同企业聚合但保留不同数量交易", () => {
  const result = previewCustomsImport(filtered);
  assert.equal(result.mapping.companyName, "Company"); assert.equal(result.mapping.hsCode, "HS Code");
  assert.equal(result.summary.inputRows, 6); assert.equal(result.summary.matchedRows, 2); assert.equal(result.summary.duplicateRows, 1); assert.equal(result.summary.filteredRows, 3);
  assert.equal(result.candidates.length, 1); const candidate = result.candidates[0];
  assert.equal(candidate.name, "ACME PARTS"); assert.equal(candidate.recordCount, 2);
  assert.deepEqual(candidate.sourceRows, [2, 4]); assert.equal(candidate.records[0].hsCode, "8708.30");
  assert.equal(candidate.records[0].raw.Quantity, "100"); assert.equal(candidate.records[1].raw.Quantity, "200");
  assert.equal(result.errors.find(e => e.row === 7).code, "DATE_UNPARSED");
  assert.ok(result.errors.some(e => e.code === "FILTERED_OUT" && e.message.includes("国家")));
  const all = previewCustomsImport({ ...base, text: csv });
  assert.equal(all.candidates.filter(c => c.name === "ACME PARTS").length, 2);
  assert.ok(all.candidates.find(c => c.country === "US").warnings.some(w => w.includes("不等于真实买家")));
});

test("Excel TSV与未知表头手动映射；保留前导零、不猜角色、不解释编号或日期序号", () => {
  const text = "Target entity\tTerritory\tTariff\tCargo\tTrade day\nExample Parts\tUK\t001234\tBrake shoes\t45251\nOther Parts\tUK\t8.7083E+05\tBrake lining\t2026/11/20";
  const initial = previewCustomsImport({ ...base, text });
  assert.equal(initial.headers[0], "Target entity"); assert.equal(initial.errors[0].code, "COMPANY_COLUMN_REQUIRED");
  const mapping = { companyName: "Target entity", country: "Territory", hsCode: "Tariff", description: "Cargo", date: "Trade day" };
  const result = previewCustomsImport({ ...base, text, mapping });
  assert.equal(result.candidates[0].records[0].hsCode, "001234"); assert.equal(result.candidates[0].records[0].date, "");
  assert.equal(result.candidates[0].role, "未注明");
  assert.ok(result.candidates[1].warnings.some(w => w.includes("科学计数法")));
  const prefix = previewCustomsImport({ ...base, text, mapping, filters: { hsPrefix: "0012" } });
  assert.equal(prefix.candidates.length, 1);
});

test("HS原码长度异常仅提示待核对，合法短前缀仍能粗筛且不改原码", () => {
  const text = "Company,Country,HS Code,Description\nShort code company,UK,8708,Brake parts\nSeven digit company,UK,8708301,Brake parts\nFull code company,UK,8708301000,Brake shoes\nLeading zero company,UK,001234,Other parts";
  const result = previewCustomsImport({ ...base, text, filters: { hsPrefix: "8708" } });
  assert.equal(result.candidates.length, 3); assert.equal(result.candidates[0].records[0].hsCode, "8708"); assert.equal(result.candidates[1].records[0].hsCode, "8708301");
  assert.ok(result.candidates[0].warnings.some(value => value.includes("不是 6、8 或 10 位"))); assert.ok(result.candidates[1].warnings.some(value => value.includes("未补零")));
  assert.ok(!result.candidates[2].warnings.some(value => value.includes("不是 6、8 或 10 位")));
  const leading = previewCustomsImport({ ...base, text, filters: { hsPrefix: "00" } }); assert.equal(leading.candidates[0].records[0].hsCode, "001234");
});

test("授权/500行/500KB/坏引号/失效映射与非法筛选均明确拒绝", () => {
  assert.throws(() => previewCustomsImport({ ...base, text: csv, authorized: false }), e => e.code === "CUSTOMS_AUTH_REQUIRED");
  assert.throws(() => previewCustomsImport({ ...base, text: "Company\n" + Array(501).fill("Company A").join("\n") }), e => e.code === "CUSTOMS_ROW_LIMIT");
  assert.throws(() => previewCustomsImport({ ...base, text: "Company\n" + "中".repeat(170000) }), e => e.code === "CUSTOMS_TEXT_LIMIT");
  assert.throws(() => previewCustomsImport({ ...base, text: 'Company,Country\n"Unclosed,UK' }), e => e.code === "INVALID_CSV");
  assert.throws(() => previewCustomsImport({ ...base, text: csv, mapping: { companyName: "MISSING" } }), e => e.code === "INVALID_MAPPING");
  assert.throws(() => previewCustomsImport({ ...base, text: csv, filters: { dateFrom: "2026-02-31" } }), e => e.code === "INVALID_DATE_FILTER");
  assert.throws(() => previewCustomsImport({ ...base, text: "Company\nA", filters: { hsPrefix: "8708" } }), e => e.code === "FILTER_MAPPING_REQUIRED");
});

async function database() {
  const sql = new DatabaseSync(":memory:");
  for (const file of (await readdir(new URL("../drizzle/", import.meta.url))).filter(f => f.endsWith(".sql")).sort()) sql.exec(await readFile(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  return { raw: sql, prepare(query) { return { bind(...values) { return { async first() { return sql.prepare(query).get(...values) || null; }, async run() { return { meta: { changes: Number(sql.prepare(query).run(...values).changes) } }; } }; } }; } };
}
const ctx = (db, ownerId = "u:customs-test") => ({ db, ownerId, authenticated: true, dataKey: "" });

test("只导入人工所选且服务端重算hash；重导不重复交易、保留来源、不调用网络", async () => {
  const db = await database(), originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Customs import must not call a network API"); };
  try {
    await withPlatformContext(ctx(db), async () => {
      const preview = previewCustomsImport({ ...base, text: csv });
      const selected = preview.candidates.find(c => c.country === "UK" && c.name === "ACME PARTS");
      const payload = { ...base, text: csv, mapping: preview.mapping, previewHash: preview.previewHash, selectedKeys: [selected.key] };
      await assert.rejects(() => importCustomsSelection({ ...payload, text: csv + "\nNEW,UK,870830,Brake,2026-11-20,,,,1" }), e => e.code === "CUSTOMS_PREVIEW_CHANGED");
      await assert.rejects(() => importCustomsSelection({ ...payload, selectedKeys: ["not-in-preview"] }), e => e.code === "CUSTOMS_SELECTION_CHANGED");
      await assert.rejects(() => importCustomsSelection({ ...payload, selectedKeys: [] }), e => e.code === "CUSTOMS_SELECTION_REQUIRED");
      const first = await importCustomsSelection(payload); assert.equal(first.summary.importedCompanies, 1); assert.equal(first.summary.importedRecords, 2);
      let raw = (await readRaw()).state;
      assert.equal(raw.companies.length, 1); assert.equal(raw.companies[0].grade, "unknown"); assert.equal(raw.companies[0].stage, "待研究");
      assert.equal(raw.customsRecords[0].sourceName, base.sourceName); assert.equal(raw.customsRecords[0].row, 2);
      assert.equal(raw.customsRecords[0].hsCode, "8708.30"); assert.equal(raw.customsRecords[0].role, "Importer");
      assert.equal(raw.customsBatches[0].onlineQuery, false); assert.equal(raw.companies[0].contacts.length, 0);
      const again = await importCustomsSelection(payload); assert.equal(again.summary.importedCompanies, 0); assert.equal(again.summary.importedRecords, 0); assert.equal(again.summary.duplicateRecords, 2);
      raw = (await readRaw()).state; assert.equal(raw.customsRecords.length, 2); assert.equal(raw.companies[0].evidence.length, 2);
      assert.equal(raw.companies[0].evidence[0].type, "document");
      const mappingChanged = { ...payload, mapping: { ...preview.mapping, website: "" } };
      const rePreview = previewCustomsImport(mappingChanged);
      const mappedAgain = await importCustomsSelection({ ...mappingChanged, previewHash: rePreview.previewHash, selectedKeys: [rePreview.candidates.find(c => c.country === "UK" && c.name === "ACME PARTS").key] });
      assert.equal(mappedAgain.summary.importedRecords, 0); assert.equal(mappedAgain.summary.duplicateRecords, 2);
      await mutatePlatform(s => { s.companies[0].name = "Manually renamed company"; s.companies[0].market = "Manually corrected market"; });
      const renamedReplay = await importCustomsSelection(payload); assert.equal(renamedReplay.summary.importedCompanies, 0);
      assert.equal((await readRaw()).state.companies.length, 1);
    });
    await withPlatformContext(ctx(db, "u:other"), async () => {
      const other = (await readRaw()).state; assert.equal(other.companies.length, 0); assert.equal((other.customsRecords || []).length, 0);
    });
  } finally { globalThis.fetch = originalFetch; db.raw.close(); }
});

test("严格公司名+国家+真实/演示隔离；合并只追加证据不覆盖人工等级安排与身份", async () => {
  const db = await database();
  try {
    await withPlatformContext(ctx(db), async () => {
      let state = await act("create_company", { name: "ACME PARTS", market: "UK", website: "https://acme.example/manual-source", grade: "A", stage: "样品沟通", owner: "Human owner", nextAction: "人工安排", nextFollowUpAt: "2027-01-01T00:00:00Z", buyerRole: "人工核验分销商" });
      const id = state.companies[0].id;
      const real = { ...filtered, dataClass: "real" }, p = previewCustomsImport(real);
      const merged = await importCustomsSelection({ ...real, previewHash: p.previewHash, selectedKeys: [p.candidates[0].key] });
      assert.equal(merged.summary.mergedCompanies, 1); assert.equal(merged.summary.importedCompanies, 0);
      const company = (await readRaw()).state.companies.find(c => c.id === id);
      assert.equal(company.grade, "A"); assert.equal(company.gradeSource, "manual"); assert.equal(company.stage, "样品沟通"); assert.equal(company.owner, "Human owner");
      assert.equal(company.nextAction, "人工安排"); assert.equal(company.website, "https://acme.example/manual-source"); assert.equal(company.buyerRole, "人工核验分销商");
      const demo = previewCustomsImport(filtered);
      const separate = await importCustomsSelection({ ...filtered, previewHash: demo.previewHash, selectedKeys: [demo.candidates[0].key] });
      assert.equal(separate.summary.importedCompanies, 1);
      state = (await readRaw()).state; assert.equal(state.companies.length, 2); assert.equal(state.companies.filter(c => c.dataClass === "synthetic").length, 1);
      assert.equal(state.customsRecords.filter(r => r.dataClass === "real").length, 2); assert.equal(state.customsRecords.filter(r => r.dataClass === "synthetic").length, 2);
    });
  } finally { db.raw.close(); }
});

test("缺国家的同名主体不自动合并；网站身份冲突必须先人工核对", async () => {
  const db = await database();
  try {
    await withPlatformContext(ctx(db), async () => {
      const payload = { ...base, text: "Company,Country,HS Code,Description,Website\nSame name,,870830,Brake A,https://one.example\nSame name,,870830,Brake B,https://two.example" };
      const p = previewCustomsImport(payload); assert.equal(p.candidates.length, 2);
      assert.ok(p.candidates.every(c => c.warnings.some(w => w.includes("独立待核身份"))));
      await importCustomsSelection({ ...payload, previewHash: p.previewHash, selectedKeys: p.candidates.map(c => c.key) });
      assert.equal((await readRaw()).state.companies.length, 2);
      const mixedSites = { ...base, text: "Company,Country,HS Code,Description,Website\nMixed name,UK,870830,Brake A,https://one.example\nMixed name,UK,870830,Brake B,https://two.example" };
      const mixed = previewCustomsImport(mixedSites); assert.equal(mixed.candidates[0].identityConflict, true);
      await assert.rejects(() => importCustomsSelection({ ...mixedSites, previewHash: mixed.previewHash, selectedKeys: [mixed.candidates[0].key] }), e => e.code === "CUSTOMS_IDENTITY_CONFLICT");
      await act("create_company", { name: "Existing real company", market: "UK", website: "https://trusted.example" });
      const conflictPayload = { ...base, dataClass: "real", text: "Company,Country,Description,Website\nExisting real company,UK,Brake,https://different.example" };
      const conflict = previewCustomsImport(conflictPayload);
      await assert.rejects(() => importCustomsSelection({ ...conflictPayload, previewHash: conflict.previewHash, selectedKeys: [conflict.candidates[0].key] }), e => e.code === "CUSTOMS_IDENTITY_CONFLICT");
      assert.equal((await readRaw()).state.companies.find(c => c.name === "Existing real company").evidence.length, 0);
    });
  } finally { db.raw.close(); }
});
