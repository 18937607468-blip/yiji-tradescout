// Only local Miniflare D1. This script cannot migrate a remote database.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
for (const file of readdirSync("drizzle").filter(name => name.endsWith(".sql")).sort()) {
  const result = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", "dist/server/wrangler.json", "--persist-to", ".wrangler/state", "--file", `drizzle/${file}`], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
