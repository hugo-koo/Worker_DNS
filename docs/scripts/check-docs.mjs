/**
 * @file check-docs.mjs
 * @description Validates Starlight documentation symmetry across locales (en, zh-cn, zh-tw),
 * sidebar.order consistency, and Mermaid node label quoting.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const docsContentRoot = path.resolve(__dirname, '..', 'src', 'content', 'docs');

const LOCALES = ['en', 'zh-cn', 'zh-tw'];

function collectDocs(dir, baseDir, results = new Map(), skipTopDirs = new Set()) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (dir === baseDir && skipTopDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectDocs(fullPath, baseDir, results, skipTopDirs);
    } else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
      const rel = path.relative(baseDir, fullPath).replaceAll(path.sep, '/');
      results.set(rel, fullPath);
    }
  }
  return results;
}

function extractSidebarOrder(content) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const orderMatch = fmMatch[1].match(/^\s*order:\s*(\d+)/m);
  return orderMatch ? Number(orderMatch[1]) : null;
}

function findUnquotedMermaidLabels(content) {
  const issues = [];
  const mermaidBlocks = content.matchAll(/```mermaid\r?\n([\s\S]*?)```/g);
  for (const match of mermaidBlocks) {
    const lines = match[1].split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('%%') || trimmed.startsWith('sequenceDiagram')) continue;
      // Match node[label] where label is not quoted and contains parentheses
      const unquotedMatch = trimmed.match(/\b[A-Za-z0-9_-]+\[([^"\]\n]*[()][^"\]\n]*)\]/);
      if (unquotedMatch) {
        issues.push(trimmed);
      }
    }
  }
  return issues;
}

const byLocale = {
  en: collectDocs(docsContentRoot, docsContentRoot, new Map(), new Set(['zh-cn', 'zh-tw'])),
  'zh-cn': collectDocs(path.join(docsContentRoot, 'zh-cn'), path.join(docsContentRoot, 'zh-cn')),
  'zh-tw': collectDocs(path.join(docsContentRoot, 'zh-tw'), path.join(docsContentRoot, 'zh-tw')),
};

let errors = 0;

// 1. Check locale file symmetry
const allKeys = new Set([...byLocale.en.keys(), ...byLocale['zh-cn'].keys(), ...byLocale['zh-tw'].keys()]);
for (const key of Array.from(allKeys).sort()) {
  for (const locale of LOCALES) {
    if (!byLocale[locale].has(key)) {
      console.error(`[docs-check] Missing file in locale "${locale}": ${key}`);
      errors++;
    }
  }
}

// 2. Check sidebar.order consistency & Mermaid syntax
for (const key of Array.from(allKeys).sort()) {
  const orders = new Map();
  for (const locale of LOCALES) {
    const filePath = byLocale[locale].get(key);
    if (!filePath) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    const order = extractSidebarOrder(content);
    orders.set(locale, order);

    const mermaidIssues = findUnquotedMermaidLabels(content);
    for (const issue of mermaidIssues) {
      console.error(`[docs-check] Unquoted Mermaid label with parentheses in ${locale}/${key}: ${issue}`);
      errors++;
    }
  }
  const uniqueOrders = new Set(Array.from(orders.values()).filter((v) => v !== null));
  if (uniqueOrders.size > 1) {
    console.error(`[docs-check] Mismatched sidebar.order for ${key}: ${JSON.stringify(Object.fromEntries(orders))}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`[docs-check] Failed with ${errors} error(s).`);
  process.exit(1);
}

console.log(`[docs-check] Passed: ${allKeys.size} pages verified across ${LOCALES.join(', ')}.`);
