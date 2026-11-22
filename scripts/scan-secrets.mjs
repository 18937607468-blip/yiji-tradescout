// Dependency-free publication check. Reports locations only, never matched secrets.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const git = args => execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024 });
const findings = [];
const patterns = [
  /\b(?:sk-(?:proj-)?|tvly-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{16,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']([^"'\n]{16,})["']/gi,
];
function scan(bytes, location) {
  if (bytes.includes(0)) return; // binary assets; tracked image inventory reviewed separately
  const text = bytes.toString("utf8");
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[1] || match[0];
      // Explicit synthetic fixtures, not a blanket test-file exemption.
      if (/^(?:tvly-test-|synthetic-|test-only-|FAKE-|\[REDACTED\])/.test(value)) continue;
      // Computed expressions are not literal credentials.
      if (match[1] && /[+{};]|\.repeat\(|\b(?:await|typeof)\b/.test(value)) continue;
      findings.push({ location, line: text.slice(0, match.index).split("\n").length, rule: patterns.indexOf(pattern) + 1 });
    }
  }
}
const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean);
for (const path of new Set(files)) {
  if (/(^|\/)(?:\.env[^/]*|\.dev\.vars[^/]*|node_modules|\.next|\.data|\.wrangler|private-data|exports)(?:\/|$)/.test(path) && path !== ".env.example") findings.push({ location: path, rule: "forbidden-file" });
  scan(readFileSync(path), path);
}
let historyBlobs = 0;
if (process.argv.includes("--history")) {
  const objects = git(["rev-list", "--objects", "--all"]).toString().trim().split("\n").filter(Boolean);
  for (const object of objects) {
    const [id, ...parts] = object.split(" ");
    if (git(["cat-file", "-t", id]).toString().trim() !== "blob") continue;
    historyBlobs++;
    scan(git(["cat-file", "blob", id]), `history:${id.slice(0, 12)}:${parts.join(" ")}`);
    const path = parts.join(" ");
    if (/(^|\/)(?:\.env[^/]*|\.dev\.vars[^/]*|\.data|private-data|exports)(?:\/|$)/.test(path) && path !== ".env.example") findings.push({ location: `history:${id.slice(0, 12)}:${path}`, rule: "forbidden-file" });
  }
}
console.log(JSON.stringify({ files: new Set(files).size, historyBlobs, findings }, null, 2));
if (findings.length) process.exitCode = 1;
