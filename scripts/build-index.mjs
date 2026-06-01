// Scans the documents/ folder and injects a list of links into index.html
// between the DOCS_LIST_START / DOCS_LIST_END markers.
// Runs in CI before the Pages artifact is uploaded.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const DOCS_DIR = join(ROOT, "documents");
const INDEX = join(ROOT, "index.html");

const START = "<!-- DOCS_LIST_START -->";
const END = "<!-- DOCS_LIST_END -->";

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function prettify(filename) {
  return filename
    .replace(/\.html?$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const entries = await readdir(DOCS_DIR, { withFileTypes: true }).catch(() => []);
const files = entries
  .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
  .map((e) => e.name)
  .sort((a, b) => a.localeCompare(b));

let block;
if (files.length === 0) {
  block = `<div class="empty">
      No documents yet. Drop an <code>.html</code> file into the
      <code>documents/</code> folder and push — it will appear here automatically.
    </div>`;
} else {
  const items = files
    .map((f) => {
      const href = `documents/${encodeURIComponent(f)}`;
      return `      <li><a href="${href}">${escapeHtml(prettify(f))}</a></li>`;
    })
    .join("\n");
  block = `<ul class="docs">\n${items}\n    </ul>`;
}

const html = await readFile(INDEX, "utf8");
const pattern = new RegExp(`${START}[\\s\\S]*?${END}`);
const replaced = html.replace(pattern, `${START}\n    ${block}\n    ${END}`);

await writeFile(INDEX, replaced);
console.log(`Indexed ${files.length} document(s).`);
