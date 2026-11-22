import test from "node:test";
import assert from "node:assert/strict";
import { validateResearch } from "../lib/platform/research.mjs";
import { researchGradeFor } from "../lib/platform/screening.mjs";
import { companyIdentity } from "../lib/platform/domain.mjs";
import { relatedPages, validatePublicUrl } from "../lib/platform/web.mjs";

const lining = { id: "lining", name: "鼓式刹车片 WVA 19488", category: "brake_lining", codes: [{ namespace: "WVA", value: "19488" }, { namespace: "HS", value: "6813810000" }] };
const shoe = { id: "shoe", name: "SAF 420×200 制动蹄", category: "brake_shoe", codes: [{ namespace: "OE", value: "3054005300" }] };
const roleSource = { id: "role", snippet: "We are an importer and distributor of commercial truck parts." };
const roleFact = { field: "buyer_role", value: "进口及经销角色", sourceId: "role", quote: roleSource.snippet };
function analyze(quote, relationship = "same_code", product = lining, surrounding = quote) {
  return validateResearch(JSON.stringify({ websiteFacts: [], productMatches: [{ productId: product.id, relationship, sourceId: "source", quote }], openingQuestion: null, unknowns: [], recommendedNextAction: "" }), [{ id: "source", snippet: surrounding }], [product]);
}
function assertHeld(result, reason) {
  assert.equal(result.productMatches.length, 0);
  assert.equal(researchGradeFor(result.productMatches), "unknown");
  assert.ok(result.unknowns.some(text => text.includes(reason)), result.unknowns.join("; "));
}

test("Equal digits, HS and wrong identifier systems cannot establish WVA equivalence", () => {
  for (const quote of ["Internal catalogue item 19488 is a passenger-car accessory.", "Our truck brake lining uses HS 6813810000.", "The part is OE 19488; our truck catalogue is available.", "WVA 194880 is a different complete identifier.", "Truck brake lining WVA 19488/02 is a specified variant."]) {
    assertHeld(analyze(quote), "编号");
  }
  const valid = analyze("Commercial truck brake lining, WVA No. 19488.");
  assert.equal(valid.productMatches.length, 1);
  assert.equal(researchGradeFor(valid.productMatches, [roleFact], [roleSource]), "B");
});

test("OE reference requires explicit namespace or the same manufacturer brand", () => {
  assert.equal(analyze('BRAKE SHOE SAF 420x200 22 inch; Ref. number: 3054005300.', "same_code", shoe).productMatches.length, 1);
  assert.equal(analyze("OE 3054005300 brake shoe.", "same_code", shoe).productMatches.length, 1);
  assertHeld(analyze("Invoice number: 3054005300. Product catalogue.", "same_code", shoe), "编号");
  assertHeld(analyze("BPW brake shoe; Ref. number: 3054005300.", "same_code", shoe), "编号");
  assertHeld(analyze("SAF brake shoe WVA 3054005300.", "same_code", shoe), "编号");
});

test("Category-level qualification needs commercial vehicles AND the precise brake type", () => {
  for (const quote of ["We provide office furniture and home decoration.", "We sell spare parts for trucks and trailers.", "We supply brake linings for passenger cars.", "We sell truck brake shoes for heavy-duty vehicles.", "We supply heavy-duty brake linings for industrial machinery."]) assertHeld(analyze(quote, "related_category"), "核验");
  const supported = analyze("We supply brake linings for commercial trucks and trailers.", "related_category");
  assert.equal(supported.productMatches.length, 1);
  assert.equal(researchGradeFor(supported.productMatches, [roleFact], [roleSource]), "B");
  assertHeld(analyze("We do not supply brake linings for commercial trucks.", "related_category"), "否定");
});

test("Discontinuation, incompatibility and model-year limits remain review items", () => {
  assertHeld(analyze("WVA 19488 was discontinued in 2018; it does not fit model-year 2024."), "待核验");
  assertHeld(analyze("WVA 19488 fits only model years 2010 to 2018."), "年份");
  assertHeld(analyze("WVA 19488 to SAE standard edition 2018."), "年份");
  const quote = "Truck brake lining WVA 19488.";
  assertHeld(analyze(quote, "same_code", lining, quote + " This part is obsolete and incompatible with the newer specification."), "待核验");
  assert.equal(analyze("Catalogue updated 2026. WVA 19488 brake lining.").productMatches.length, 1);
});

test("Product/contact page quota cannot be exhausted by duplicate contact choices", () => {
  const urls = relatedPages('<a href="/contact">Contact</a><a href="/contact-sales">Contact Sales</a><a href="/products/brake-lining-19488">WVA 19488 Brake lining</a>', "https://example.com/");
  assert.deepEqual(urls, ["https://example.com/products/brake-lining-19488", "https://example.com/contact"]);
});

test("Made-in-China companies keep distinct page identity and remain manual sources", () => {
  const company = path => ({ name: path, website: "https://www.made-in-china.com/showroom/" + path });
  assert.notEqual(companyIdentity(company("supplier-a")), companyIdentity(company("supplier-b")));
  assert.equal(companyIdentity(company("supplier-a")), companyIdentity(company("supplier-a/")));
  for (const website of [company("supplier-a").website, "https://supplier-a.en.made-in-china.com/"]) assert.throws(() => validatePublicUrl(website), error => error.code === "MANUAL_SOURCE_REQUIRED");
});

test("Invented quotes are still rejected instead of merely being downgraded", () => {
  assert.throws(() => analyze("WVA 19488 for trucks.", "same_code", lining, "No such code is present in this source."), error => error.code === "UNSUPPORTED_PRODUCT");
});

test("Same-number evidence alone or a manufacturer/supplier description never makes a B buyer", () => {
  const result = analyze("Truck brake lining WVA 19488.");
  assert.equal(result.productMatches.length, 1, "keep the useful product lead");
  assert.equal(researchGradeFor(result.productMatches), "unknown");
  for (const snippet of ["We manufacture and supply truck brake linings.", "We supply to importers and distributors.", "Our customers are importers and wholesalers."]) {
    assert.equal(researchGradeFor(result.productMatches, [{ ...roleFact, value: "模型声称进口商", quote: snippet }], [{ ...roleSource, snippet }]), "unknown");
  }
});

test("B requires a quoted company importing/distribution role; unsupported role quotes cannot qualify", () => {
  const result = analyze("Truck brake lining WVA 19488.");
  assert.equal(researchGradeFor(result.productMatches, [roleFact], [roleSource]), "B");
  assert.equal(researchGradeFor(result.productMatches, [roleFact], [{ ...roleSource, snippet: "We manufacture brake linings." }]), "unknown");
  assert.equal(researchGradeFor([], [roleFact], [roleSource]), "unknown");
});

test("Explicit passenger-only use and conflicting brake categories defeat a same-number match", () => {
  assertHeld(analyze("Passenger-car accessory WVA 19488."), "乘用车");
  assertHeld(analyze("WVA 19488.", "same_code", lining, "Passenger-car accessory only. WVA 19488."), "乘用车");
  assertHeld(analyze("WVA 19488 for passenger cars only, not commercial vehicles."), "乘用车");
  assertHeld(analyze("Truck brake shoe WVA 19488."), "品类");
  assertHeld(analyze("WVA 19488 non-commercial brake lining."), "非商用");
});
