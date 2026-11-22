import test from "node:test";
import assert from "node:assert/strict";
import { validateInquiryExtraction } from "../lib/platform/inquiry-extract.mjs";

const output = (fields, unknowns = []) => JSON.stringify({ fields, unknowns });
const row = (field, value, quote) => ({ field, value, quote });

test("preserves directly quoted fields and explicit dimensions without inference", () => {
  const text = "We need WVA 19032. Width: 180 mm. Quantity: 250 pieces. Size: 1+.";
  const result = validateInquiryExtraction(output([
    row("partCode", "19032", "We need WVA 19032."),
    row("widthMm", "180", "Width: 180 mm."),
    row("quantity", "250", "Quantity: 250 pieces."),
    row("unit", "pieces", "Quantity: 250 pieces."),
    row("sizeCode", "1+", "Size: 1+."),
  ]), text);
  assert.equal(result.fields.length, 5);
  assert.equal(result.fields[0].value, "19032");
});

test("allows only case/whitespace normalization", () => {
  const result = validateInquiryExtraction(output([row("axleBrand", "BPW", "Axle: BPW")]), "AXLE:   bpw");
  assert.equal(result.fields.length, 1);
});

test("rejects hallucinated values, unsupported quotes and shortened or expanded part codes", () => {
  assert.throws(() => validateInquiryExtraction(output([row("partCode", "19369", "WVA 19032")]), "WVA 19032"), error => error.code === "EXTRACTION_UNSUPPORTED_VALUE");
  assert.throws(() => validateInquiryExtraction(output([row("axleBrand", "SAF", "Axle SAF")]), "Axle BPW"), error => error.code === "EXTRACTION_UNSUPPORTED_QUOTE");
  assert.throws(() => validateInquiryExtraction(output([row("partCode", "1903", "WVA 19032")]), "WVA 19032"), error => error.code === "EXTRACTION_UNSUPPORTED_VALUE");
  assert.throws(() => validateInquiryExtraction(output([row("partCode", "19032-1", "WVA 19032")]), "WVA 19032"), error => error.code === "EXTRACTION_UNSUPPORTED_VALUE");
  assert.throws(() => validateInquiryExtraction(output([row("partCode", "19032", "WVA 19032-1")]), "WVA 19032-1"), error => error.code === "EXTRACTION_UNSUPPORTED_VALUE");
});

test("rejects prices, inferred namespaces, fitment fields and unconstrained unknowns", () => {
  for (const field of ["price", "candidatePart", "partType", "codeNamespace", "compatibleAxle"]) {
    assert.throws(() => validateInquiryExtraction(output([row(field, "20", "Price 20")]), "Price 20"), error => error.code === "EXTRACTION_INVALID_SCHEMA");
  }
  assert.throws(() => validateInquiryExtraction(output([], ["Recommend part 19032 for USD 20"]), "Need parts"), error => error.code === "EXTRACTION_INVALID_SCHEMA");
});

test("rejects duplicate fields and unexpected JSON keys", () => {
  assert.throws(() => validateInquiryExtraction(output([row("quantity", "250", "qty250"), row("quantity", "250", "qty250")]), "qty250"), error => error.code === "EXTRACTION_DUPLICATE_FIELD");
  assert.throws(() => validateInquiryExtraction(JSON.stringify({ fields: [], unknowns: [], price: 20 }), "quote"), error => error.code === "EXTRACTION_INVALID_SCHEMA");
  assert.throws(() => validateInquiryExtraction("not JSON", "quote"), error => error.code === "EXTRACTION_INVALID_JSON");
});

test("does not infer millimetres or convert STD/1+/2+", () => {
  assert.throws(() => validateInquiryExtraction(output([row("widthMm", "180", "Width 180")]), "Width 180"), error => error.code === "EXTRACTION_UNIT_UNSUPPORTED");
  assert.throws(() => validateInquiryExtraction(output([row("thicknessMm", "1+", "Size 1+")]), "Size 1+"), error => error.code === "EXTRACTION_UNIT_UNSUPPORTED");
  assert.equal(validateInquiryExtraction(output([row("rawWidth", "180", "Width 180")]), "Width 180").fields[0].field, "rawWidth");
});

test("withholds negative, conditional, uncertain and conflicting values for review", () => {
  for (const text of ["Not BPW", "Maybe BPW", "If BPW", "不是BPW", "BPW or SAF"]) {
    const result = validateInquiryExtraction(output([row("axleBrand", "BPW", "BPW")]), text);
    assert.equal(result.fields.length, 0);
    assert.match(result.unknowns[0], /axleBrand/);
  }
  const result = validateInquiryExtraction(output([row("widthMm", "200", "Width 200 mm")]), "Width 180 mm. Width 200 mm.");
  assert.equal(result.fields.length, 0);
  assert.match(result.unknowns[0], /widthMm/);
});

test("does not select a single part or quantity from multi-line competing requests", () => {
  const result = validateInquiryExtraction(output([
    row("partCode", "19032", "WVA 19032"), row("quantity", "250", "QTY 250"),
  ]), "WVA 19032 QTY 250\nWVA 19369 QTY 200");
  assert.equal(result.fields.length, 0);
  assert.equal(result.unknowns.length, 2);
});

test("does not treat a vehicle model year or whole-vehicle payload as axle attributes", () => {
  const text = "Truck model year 2020. Vehicle payload 20 tons. Axle brand BPW.";
  const result = validateInquiryExtraction(output([
    row("year", "2020", "Truck model year 2020."),
    row("loadTons", "20", "Vehicle payload 20 tons. Axle brand BPW."),
  ]), text);
  assert.equal(result.fields.length, 0);
  assert.equal(result.unknowns.length, 2);
});

test("accepts explicit axle manufacturing year and rated axle load", () => {
  const text = "Axle manufactured in 2023. Rated axle load: 10 tons.";
  const result = validateInquiryExtraction(output([
    row("year", "2023", "Axle manufactured in 2023."),
    row("loadTons", "10", "Rated axle load: 10 tons."),
  ]), text);
  assert.equal(result.fields.length, 2);
});
