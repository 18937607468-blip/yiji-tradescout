import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { calculateMaterialCost, convertLength, convertDensity, convertMaterialPrice, buildMaterialCostDraft } from "../lib/platform/material-cost.mjs";
import { withPlatformContext } from "../lib/platform/context.mjs";
import { act } from "../lib/platform/domain.mjs";
import { readRaw } from "../lib/platform/store.mjs";

const fixture = () => ({
  outerArc: { value: "220", unit: "mm" }, width: { value: "180", unit: "mm" },
  thickness1: { value: "17.5", unit: "mm" }, thickness2: { value: "10.5", unit: "mm" },
  density: { value: "2.2", unit: "g/cm3" }, adjustmentFactor: "1.15",
  materialPrice: { value: "20", per: "kg", currency: "CNY", sourceText: "Synthetic material price fixture, not an actual company quote." },
  order: { quantity: "250", unit: "piece", piecesPerSet: "" }, note: "Synthetic calculation fixture.",
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test("Original formula calculates material reference and totals from unrounded unit amount", () => {
  const answer = calculateMaterialCost(fixture());
  near(answer.normalized.averageThicknessMm, 14); near(answer.result.volumeMm3, 554400);
  near(answer.result.theoreticalMassKg, 1.21968); near(answer.result.adjustedMassKg, 1.402632);
  near(answer.result.materialPerPiece, 28.05264); near(answer.result.materialTotal, 7013.16);
  assert.notEqual(answer.result.materialTotal, Number(answer.result.materialPerPiece.toFixed(2)) * 250);
  assert.equal(answer.result.currency, "CNY"); assert.equal(answer.steps.length, 6);
  const reversed = fixture(); [reversed.thickness1, reversed.thickness2] = [reversed.thickness2, reversed.thickness1];
  near(calculateMaterialCost(reversed).result.materialTotal, answer.result.materialTotal);
});

test("Equivalent length, density and price units preserve the same physical calculation", () => {
  for (const unit of ["mm", "cm", "m", "in"]) {
    const raw = fixture();
    for (const field of ["outerArc", "width", "thickness1", "thickness2"]) raw[field] = { value: String(convertLength(raw[field].value, "mm", unit)), unit };
    near(calculateMaterialCost(raw).result.materialTotal, 7013.16);
  }
  for (const per of ["kg", "g", "tonne", "lb"]) {
    const raw = fixture(); raw.materialPrice.value = String(convertMaterialPrice("20", "kg", per)); raw.materialPrice.per = per;
    near(calculateMaterialCost(raw).normalized.materialPricePerKg, 20); near(calculateMaterialCost(raw).result.materialTotal, 7013.16);
  }
  near(convertMaterialPrice(20, "kg", "lb"), 9.0718474);
  near(convertMaterialPrice(20, "kg", "g"), 0.02);
  near(convertMaterialPrice(20, "kg", "tonne"), 20000);
  const raw = fixture(); raw.density = { value: "2200", unit: "kg/m3" };
  near(convertDensity(2.2, "g/cm3", "kg/m3"), 2200); near(calculateMaterialCost(raw).result.materialTotal, 7013.16);
});

test("Display-unit changes preserve the submitted originals without accumulating rounding", () => {
  const raw = fixture();
  for (let i = 0; i < 100; i++) {
    raw.outerArc.displayUnit = ["in", "cm", "m", "mm"][i % 4];
    raw.materialPrice.displayPer = ["lb", "g", "tonne", "kg"][i % 4];
    raw.density.displayUnit = i % 2 ? "g/cm3" : "kg/m3";
    const result = calculateMaterialCost(raw);
    assert.equal(result.inputs.outerArc.value, "220"); assert.equal(result.inputs.outerArc.unit, "mm");
    assert.equal(result.inputs.materialPrice.value, "20"); assert.equal(result.inputs.materialPrice.per, "kg");
    near(result.result.materialTotal, 7013.16);
  }
});

test("Unknown quantity or pieces per set keeps a valid unit amount but no invented total", () => {
  for (const order of [{ quantity: "", unit: "piece", piecesPerSet: "" }, { quantity: "250", unit: "set", piecesPerSet: "" }]) {
    const answer = calculateMaterialCost({ ...fixture(), order });
    near(answer.result.materialPerPiece, 28.05264); assert.equal(answer.result.materialTotal, null); assert.equal(answer.result.pieceQuantity, null);
  }
  const known = calculateMaterialCost({ ...fixture(), order: { quantity: "250", unit: "set", piecesPerSet: "8" } });
  assert.equal(known.result.pieceQuantity, 2000); near(known.result.materialTotal, 56105.28);
  assert.throws(() => calculateMaterialCost({ ...fixture(), order: { quantity: "1.5", unit: "piece", piecesPerSet: "" } }), e => e.code === "MATERIAL_INVALID_QUANTITY");
  assert.throws(() => calculateMaterialCost({ ...fixture(), order: { quantity: String(Number.MAX_SAFE_INTEGER), unit: "set", piecesPerSet: "2" } }), e => e.code === "MATERIAL_QUANTITY_OVERFLOW");
});

test("Invalid inputs, unsupported units, overflow, currency symbols and supplied totals fail explicitly", () => {
  for (const value of ["", "0", "-1", "STD", "1+", "2+", "17.5/10.5", "1,000", NaN, Infinity, null, true, "1e309"]) {
    const raw = fixture(); raw.thickness1.value = value;
    assert.throws(() => calculateMaterialCost(raw), e => e.code === "MATERIAL_INVALID_NUMBER", String(value));
  }
  const overflow = fixture(); overflow.outerArc.value = "1e308";
  assert.throws(() => calculateMaterialCost(overflow), e => e.code === "MATERIAL_INVALID_NUMBER");
  assert.throws(() => convertMaterialPrice(20, "ton", "kg"), e => e.code === "MATERIAL_INVALID_UNIT");
  assert.throws(() => calculateMaterialCost({ ...fixture(), result: { materialTotal: 1 } }), e => e.code === "MATERIAL_INVALID_INPUT");
  const currency = fixture(); currency.materialPrice.currency = "$";
  assert.throws(() => calculateMaterialCost(currency), e => e.code === "MATERIAL_CURRENCY_REQUIRED");
});

test("Draft adoption preserves catalogue assumptions and never turns SIZE markers or a single thickness into two ends", () => {
  const inquiry = { inputs: { quantity: "250", unit: "套", currency: "USD", thicknessMm: "1+", sizeCode: "2+" } };
  const candidate = { dimensionsRaw: { A_outer_arch: "220", C_width: "180", D_thickness: "17.5/10.5" } };
  const draft = buildMaterialCostDraft(inquiry, candidate);
  assert.equal(draft.outerArc.value, "220"); assert.equal(draft.thickness1.value, "17.5"); assert.equal(draft.thickness2.value, "10.5");
  assert.equal(draft.order.unit, "set"); assert.equal(draft.order.piecesPerSet, ""); assert.equal(draft.materialPrice.currency, "");
  assert.equal(draft.materialPrice.value, ""); assert.match(draft.note, /假设/);
  for (const D_thickness of ["18", "1+", "2+", "STD", "17.5/10.5/8"]) {
    const unknown = buildMaterialCostDraft(inquiry, { dimensionsRaw: { D_thickness } });
    assert.equal(unknown.thickness1.value, ""); assert.equal(unknown.thickness2.value, "");
  }
});

async function database() {
  const raw = new DatabaseSync(":memory:");
  for (const file of (await readdir(new URL("../drizzle/", import.meta.url))).filter(v => v.endsWith(".sql")).sort()) raw.exec(await readFile(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  return { raw, prepare(sql) { return { bind(...values) { return { async first() { return raw.prepare(sql).get(...values) || null; }, async run() { return { meta: { changes: Number(raw.prepare(sql).run(...values).changes) } }; } }; } }; } };
}
const context = (db, ownerId = "v:material-test") => ({ db, ownerId, authenticated: false, dataKey: "" });
async function seed() {
  const created = await act("create_company", { name: "Material calculator fixture", website: "https://material-fixture.example" });
  const companyId = created.companies.at(-1).id;
  const state = await act("save_inquiry", { companyId, inputs: { partCode: "19032", codeNamespace: "WVA", partType: "brake_lining", materialGrade: "TEST", quantity: "250", unit: "片", currency: "USD", sizeCode: "1+" }, sourceText: "Synthetic inquiry fixture: WVA 19032, quantity 250 pieces, size 1+.", sourceUrl: "https://material-fixture.example/inquiry", dataClass: "real" });
  return state.inquiries.at(-1);
}
const savePayload = inquiry => ({ companyId: inquiry.companyId, inquiryId: inquiry.id, expectedRevision: inquiry.revision, clientRequestId: "material-request-one", sourceCandidateId: "kooying-gys-007", inputs: fixture() });

test("Server saves recalculated references, original catalogue and source; retry is idempotent and no fitment/quote is created", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    const inquiry = await seed(), payload = savePayload(inquiry);
    const saved = await act("save_material_calculation", payload), record = saved.inquiries[0], calc = record.materialCalculations[0];
    assert.equal(record.revision, inquiry.revision + 1); assert.equal(calc.stale, false); near(calc.result.materialTotal, 7013.16);
    assert.equal(calc.sourceSnapshot.catalogue.dimensionsRaw.A_outer_arch, "220"); assert.equal(calc.sourceSnapshot.catalogue.dimensionsRaw.D_thickness, "17.5/10.5");
    assert.equal(calc.sourceSnapshot.inquiry.sourceText, inquiry.sourceText); assert.equal(calc.inputs.materialPrice.sourceText, fixture().materialPrice.sourceText);
    assert.equal(record.inputs.dimensionUnitConfirmed, false); assert.equal(saved.quoteHistory.length, 0); assert.equal(saved.fitmentRelations.length, 0);
    assert.ok(calc.warnings.some(w => w.includes("未换汇"))); assert.ok(calc.warnings.some(w => w.includes("1+")));
    const replay = await act("save_material_calculation", payload);
    assert.equal(replay.inquiries[0].materialCalculations.length, 1); assert.equal(replay.inquiries[0].revision, record.revision);
    const reread = (await readRaw()).state.inquiries[0]; assert.deepEqual(reread.materialCalculations[0], calc);
    const changed = structuredClone(payload); changed.inputs.materialPrice.value = "21";
    await assert.rejects(() => act("save_material_calculation", changed), e => e.code === "MATERIAL_REQUEST_CONFLICT");
    await assert.rejects(() => act("save_material_calculation", { ...payload, clientRequestId: "new-request" }), e => e.code === "REVISION_CONFLICT");
  }); } finally { db.raw.close(); }
});

test("New inquiry content preserves old calculations but marks their basis stale, including a real/synthetic switch", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    let inquiry = await seed();
    const saved = await act("save_material_calculation", savePayload(inquiry)); inquiry = saved.inquiries[0];
    const common = { id: inquiry.id, companyId: inquiry.companyId, expectedRevision: inquiry.revision, inputs: inquiry.inputs, sourceText: inquiry.sourceText, sourceUrl: inquiry.sourceUrl, dataClass: inquiry.dataClass };
    const same = await act("save_inquiry", common); assert.equal(same.inquiries[0].materialCalculations[0].stale, false);
    const changed = await act("save_inquiry", { ...common, expectedRevision: same.inquiries[0].revision, inputs: { ...common.inputs, quantity: "251" }, dataClass: "synthetic" });
    const old = changed.inquiries[0].materialCalculations[0]; assert.equal(old.stale, true); assert.equal(old.dataClass, "real"); near(old.result.materialTotal, 7013.16);
    assert.equal(old.sourceSnapshot.inquiry.inputs.quantity, "250"); assert.equal(changed.inquiries[0].dataClass, "synthetic");
  }); } finally { db.raw.close(); }
});

test("Invalid catalogue links, wrong parent/account and client money or identity fields cannot be saved", async () => {
  const db = await database();
  try { await withPlatformContext(context(db), async () => {
    const inquiry = await seed(), payload = savePayload(inquiry);
    await assert.rejects(() => act("save_material_calculation", { ...payload, sourceCandidateId: "kooying-gys-009" }), e => e.code === "MATERIAL_CANDIDATE_CHANGED");
    await assert.rejects(() => act("save_material_calculation", { ...payload, sourceCandidateId: "bpw-09.801.07.41.0" }), e => e.code === "MATERIAL_CANDIDATE_CHANGED");
    await assert.rejects(() => act("save_material_calculation", { ...payload, result: { materialTotal: 0.01 } }), e => e.code === "MATERIAL_INVALID_INPUT");
    await assert.rejects(() => act("save_material_calculation", { ...payload, dataClass: "synthetic" }), e => e.code === "MATERIAL_INVALID_INPUT");
    await assert.rejects(() => act("save_material_calculation", { ...payload, inquiryId: "other-inquiry" }), e => e.code === "NOT_FOUND");
    await withPlatformContext(context(db, "v:other-account"), async () => { await assert.rejects(() => act("save_material_calculation", payload), e => e.code === "NOT_FOUND"); });
    assert.equal((await readRaw()).state.inquiries[0].materialCalculations.length, 0);
  }); } finally { db.raw.close(); }
});
