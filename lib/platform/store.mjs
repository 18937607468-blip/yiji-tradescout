import { currentContext } from "./context.mjs";
import { defaultFitmentCatalog } from "./fitment.mjs";
import { currentCommitmentRecords } from "./assurance.mjs";
export function initialize(state = {}) {
  state.schemaVersion ||= 1; state.revision ||= 0;
  for (const key of ["companies", "products", "events", "tasks", "runLog", "inquiries", "fitmentRelations", "quoteHistory", "supplyReferences", "commitmentRecords", "customsBatches", "customsRecords", "socialSources", "financialReviews", "discoveryRuns", "websiteResolutionRuns"]) state[key] ||= [];
  state.fitmentCatalog ||= defaultFitmentCatalog();
  state.updatedAt ||= null;
  return state;
}
function storeError(code, message, status = 503) { return Object.assign(new Error(message), { code, status, publicError: true }); }
export async function readRaw() {
  const { db, ownerId } = currentContext();
  const row = await db.prepare("SELECT data, version FROM workspace_state WHERE owner_id = ?").bind(ownerId).first();
  return row ? { state: initialize(JSON.parse(row.data)), version: row.version, exists: true } : { state: initialize({}), version: 0, exists: false };
}
export async function publicState(raw) {
  const state = initialize(raw);
  const context = currentContext();
  const configured = context.authenticated && !!context.dataKey && !!await context.db.prepare("SELECT owner_id FROM model_config WHERE owner_id = ?").bind(context.ownerId).first();
  const searchConfigured = context.authenticated && !!context.dataKey && !!await context.db.prepare("SELECT owner_id FROM search_config WHERE owner_id = ?").bind(context.ownerId).first();
  return {
    companies: state.companies, products: state.products, events: state.events, tasks: state.tasks,
    inquiries: state.inquiries, fitmentRelations: state.fitmentRelations, quoteHistory: state.quoteHistory, fitmentCatalog: state.fitmentCatalog,
    supplyReferences: state.supplyReferences, commitmentRecords: currentCommitmentRecords(state),
    customsBatches: state.customsBatches, customsRecords: state.customsRecords,
    socialSources: state.socialSources,
    financialReviews: state.financialReviews,
    discoveryRuns: state.discoveryRuns,
    websiteResolutionRuns: state.websiteResolutionRuns,
    updatedAt: state.updatedAt, runLog: state.runLog.slice(-100), lastImport: state.lastImport || null,
    capabilities: { modelConfigured: configured, modelKeyStorageAvailable: !!context.dataKey, searchConfigured, searchProvider: "Tavily", websiteFetch: true, vision: false },
    identity: { authenticated: context.authenticated, displayName: context.displayName || undefined, storage: context.authenticated ? "account" : "anonymous" },
  };
}
export async function readPlatform() { return publicState((await readRaw()).state); }
export async function mutatePlatform(reducer) {
  const context = currentContext();
  const current = await readRaw();
  const next = structuredClone(current.state);
  await reducer(next);
  next.revision = current.version + 1; next.updatedAt = new Date().toISOString();
  const data = JSON.stringify(next);
  if (new TextEncoder().encode(data).byteLength > 1800000) throw storeError("WORKSPACE_FULL", "当前演示工作区达到容量上限，请先导出资料。", 413);
  const result = current.exists
    ? await context.db.prepare("UPDATE workspace_state SET data = ?, version = ?, updated_at = ? WHERE owner_id = ? AND version = ?").bind(data, next.revision, next.updatedAt, context.ownerId, current.version).run()
    : await context.db.prepare("INSERT INTO workspace_state (owner_id, data, version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id) DO NOTHING").bind(context.ownerId, data, next.revision, next.updatedAt).run();
  if (result.meta.changes !== 1) throw storeError("WORKSPACE_CONFLICT", "另一台设备刚更新了工作区，请刷新后重试；没有覆盖对方的修改。", 409);
  return publicState(next);
}
