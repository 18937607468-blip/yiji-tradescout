// Shared deterministic calculator. No model, exchange-rate service, or browser-only APIs.
export const MATERIAL_FORMULA_VERSION = "material-cost-v1";
export const MATERIAL_FORMULA = "外弧 × 宽度 × (厚度1 + 厚度2) / 2 × 核算系数 × 密度 / 1000000 × 材料每公斤单价";
const LENGTH = Object.freeze({ mm: 1, cm: 10, m: 1000, in: 25.4 });
const MASS = Object.freeze({ kg: 1, g: 0.001, tonne: 1000, lb: 0.45359237 });
const DENSITY = Object.freeze({ "g/cm3": 1, "kg/m3": 0.001 });
function fail(code, message) { throw Object.assign(new Error(message), { code, status: 400, publicError: true }); }
function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("MATERIAL_INVALID_INPUT", label + "需要填写字段对象。"); return value; }
function finite(value, label) { if (!Number.isFinite(value) || value <= 0) fail("MATERIAL_INVALID_NUMBER", label + "必须是有限正数；数值过大或过小也无法核算。"); return value; }
export function parsePositiveValue(value, label = "数值") {
  if (typeof value !== "number" && typeof value !== "string") fail("MATERIAL_INVALID_NUMBER", label + "请填写正数。");
  const raw = String(value).trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) fail("MATERIAL_INVALID_NUMBER", label + "请填写单个正数；STD、1+、2+、斜杠规格和含糊分隔符不能当数值。");
  return finite(Number(raw), label);
}
function unit(value, units, label) { if (typeof value !== "string" || !Object.hasOwn(units, value)) fail("MATERIAL_INVALID_UNIT", label + "单位不在本次支持范围内。"); return value; }
function text(value, label, max = 2000) { if (value != null && typeof value !== "string") fail("MATERIAL_INVALID_INPUT", label + "需要文字。"); const s = (value || "").trim(); if (s.length > max) fail("MATERIAL_INVALID_INPUT", label + "过长。"); return s; }
function entered(value, units, label) {
  object(value, label);
  const raw = typeof value.value === "string" ? value.value.trim() : typeof value.value === "number" ? String(value.value) : "";
  parsePositiveValue(raw, label);
  const inputUnit = unit(value.unit, units, label);
  return { value: raw, unit: inputUnit, ...(value.displayUnit !== undefined ? { displayUnit: unit(value.displayUnit, units, label) } : {}) };
}
export function convertLength(value, from, to) { return finite(parsePositiveValue(value, "长度") * LENGTH[unit(from, LENGTH, "长度")] / LENGTH[unit(to, LENGTH, "长度")], "换算长度"); }
export function convertDensity(value, from, to) { return finite(parsePositiveValue(value, "密度") * DENSITY[unit(from, DENSITY, "密度")] / DENSITY[unit(to, DENSITY, "密度")], "换算密度"); }
export function convertMaterialPrice(value, from, to) { return finite(parsePositiveValue(value, "材料单价") / MASS[unit(from, MASS, "计价")] * MASS[unit(to, MASS, "计价")], "换算材料单价"); }
function pieceCount(value, label) { const number = parsePositiveValue(value, label); if (!Number.isSafeInteger(number)) fail("MATERIAL_INVALID_QUANTITY", label + "必须为安全范围内的正整数。"); return number; }

export function calculateMaterialCost(raw) {
  object(raw, "材料核算");
  const allowed = new Set(["outerArc", "width", "thickness1", "thickness2", "density", "adjustmentFactor", "materialPrice", "order", "note"]);
  if (Object.keys(raw).some(key => !allowed.has(key))) fail("MATERIAL_INVALID_INPUT", "核算仅接收输入条件，不接收客户端金额或额外字段。");
  const inputs = {};
  for (const [field, label] of [["outerArc", "外弧"], ["width", "宽度"], ["thickness1", "厚度1"], ["thickness2", "厚度2"]]) inputs[field] = entered(raw[field], LENGTH, label);
  inputs.density = entered(raw.density, DENSITY, "密度");
  inputs.adjustmentFactor = String(raw.adjustmentFactor ?? "").trim();
  const adjustmentFactor = parsePositiveValue(raw.adjustmentFactor, "核算系数");
  const price = object(raw.materialPrice, "材料单价");
  const currency = text(price.currency, "材料价格币种", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail("MATERIAL_CURRENCY_REQUIRED", "请明确填写材料单价的三字母币种，如 CNY 或 USD；不从货币符号推测。");
  const priceValue = parsePositiveValue(price.value, "材料单价"), per = unit(price.per, MASS, "材料计价");
  inputs.materialPrice = { value: String(price.value).trim(), per, currency, sourceText: text(price.sourceText, "材料价格原文"), ...(price.displayPer !== undefined ? { displayPer: unit(price.displayPer, MASS, "显示计价") } : {}) };
  const order = object(raw.order, "采购数量");
  if (!["piece", "set"].includes(order.unit)) fail("MATERIAL_ORDER_UNIT", "请选择按片或按套核算；未知包装单位不能自动当作片。");
  inputs.order = { quantity: text(order.quantity, "采购数量", 80), unit: order.unit, piecesPerSet: text(order.piecesPerSet, "每套片数", 80) };
  inputs.note = text(raw.note, "核算备注");
  const quantity = inputs.order.quantity ? pieceCount(inputs.order.quantity, "采购数量") : null;
  const piecesPerSet = inputs.order.piecesPerSet ? pieceCount(inputs.order.piecesPerSet, "每套同规格片数") : null;
  let totalPieces = quantity === null ? null : order.unit === "piece" ? quantity : piecesPerSet === null ? null : quantity * piecesPerSet;
  if (totalPieces !== null && !Number.isSafeInteger(totalPieces)) fail("MATERIAL_QUANTITY_OVERFLOW", "总片数超过安全整数范围，请核对数量和每套片数。");
  const outerArcMm = convertLength(inputs.outerArc.value, inputs.outerArc.unit, "mm"), widthMm = convertLength(inputs.width.value, inputs.width.unit, "mm");
  const thickness1Mm = convertLength(inputs.thickness1.value, inputs.thickness1.unit, "mm"), thickness2Mm = convertLength(inputs.thickness2.value, inputs.thickness2.unit, "mm");
  const averageThicknessMm = finite(thickness1Mm / 2 + thickness2Mm / 2, "平均厚度");
  const densityGPerCm3 = convertDensity(inputs.density.value, inputs.density.unit, "g/cm3");
  const materialPricePerKg = convertMaterialPrice(priceValue, per, "kg");
  const volumeMm3 = finite(finite(outerArcMm * widthMm, "外弧与宽度乘积") * averageThicknessMm, "公式体积");
  const theoreticalMassKg = finite(volumeMm3 / 1000000 * densityGPerCm3, "理论材料重量");
  const adjustedMassKg = finite(theoreticalMassKg * adjustmentFactor, "调整后核算重量");
  const materialPerPiece = finite(adjustedMassKg * materialPricePerKg, "单片材料核算金额");
  const materialTotal = totalPieces === null ? null : finite(materialPerPiece * totalPieces, "材料核算总额");
  const warnings = ["这是衬片材料核算参考，不是最终销售报价；工艺、人工、附件、包装、运费、税费和利润另核。", "密度与核算系数是本次填写的假设，不等于实测重量或已核准损耗率。", "全程保持材料价格原币种，不自动换汇；总额按未舍入的单片值汇总。"];
  if (quantity === null) warnings.push("采购数量未填写，只显示单片参考，总片数与总额未知。");
  else if (order.unit === "set" && piecesPerSet === null) warnings.push("每套同规格衬片数量未填写，只显示单片参考，总片数与总额未知。");
  if (order.unit === "set") warnings.push("每套片数只适用于相同规格衬片；不同尺寸或附件须分别核算，不能视为整套报价。");
  const normalized = { outerArcMm, widthMm, thickness1Mm, thickness2Mm, averageThicknessMm, densityGPerCm3, adjustmentFactor, materialPricePerKg, currency, quantity, piecesPerSet, pieceQuantity: totalPieces };
  const steps = [
    { key: "thickness", label: "平均厚度", expression: `(${thickness1Mm} + ${thickness2Mm}) / 2`, value: averageThicknessMm, unit: "mm" },
    { key: "volume", label: "公式体积", expression: `${outerArcMm} × ${widthMm} × ${averageThicknessMm}`, value: volumeMm3, unit: "mm³" },
    { key: "mass", label: "理论材料重量", expression: `${volumeMm3} × ${densityGPerCm3} / 1000000`, value: theoreticalMassKg, unit: "kg/片" },
    { key: "adjustedMass", label: "调整后核算重量", expression: `${theoreticalMassKg} × ${adjustmentFactor}`, value: adjustedMassKg, unit: "kg/片" },
    { key: "unitAmount", label: "单片材料参考", expression: `${adjustedMassKg} × ${materialPricePerKg}`, value: materialPerPiece, unit: currency + "/片" },
    { key: "total", label: "材料核算总额", expression: totalPieces === null ? "总片数待确认" : `${materialPerPiece} × ${totalPieces}`, value: materialTotal, unit: currency },
  ];
  return { formulaVersion: MATERIAL_FORMULA_VERSION, inputs, normalized, result: { volumeMm3, theoreticalMassKg, adjustedMassKg, materialPerPiece, materialTotal, pieceQuantity: totalPieces, currency }, steps, warnings };
}

const numberOrEmpty = value => { try { parsePositiveValue(value); return String(value).trim(); } catch { return ""; } };
export function buildMaterialCostDraft(inquiry, candidate) {
  const saved = inquiry?.inputs || {}, dims = candidate?.dimensionsRaw || {};
  const thickness = String(dims.D_thickness || "").trim().split(/\s*\/\s*/);
  const pair = thickness.length === 2 && thickness.every(value => numberOrEmpty(value)) ? thickness : ["", ""];
  const originalUnit = String(saved.unit || "").trim().toLowerCase();
  const isPiece = /^(?:片|件|pcs?|pieces?)$/.test(originalUnit), isSet = /^(?:套|sets?)$/.test(originalUnit);
  let quantity = "";
  if (isPiece || isSet) { try { pieceCount(saved.quantity, "数量"); quantity = String(saved.quantity).trim(); } catch { /* Unknown quantity stays unknown. */ } }
  return {
    outerArc: { value: numberOrEmpty(dims.A_outer_arch), unit: "mm" },
    width: { value: numberOrEmpty(dims.C_width || saved.widthMm), unit: "mm" },
    thickness1: { value: pair[0], unit: "mm" }, thickness2: { value: pair[1], unit: "mm" },
    density: { value: "2.2", unit: "g/cm3" }, adjustmentFactor: "1.15",
    materialPrice: { value: "", per: "kg", currency: "", sourceText: "" },
    order: { quantity, unit: isSet ? "set" : "piece", piecesPerSet: "" },
    note: candidate ? "采用目录原值，尺寸按 mm 假设；斜杠厚度按两端厚度试算，尚未确认适配。" : "尺寸按 mm、密度 2.2 g/cm³、系数 1.15 起始假设，可逐项核对和修改。",
  };
}
