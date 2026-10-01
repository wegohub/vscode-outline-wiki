#!/usr/bin/env node
/**
 * 断言 webview bundle 里 prosemirror-* 只有一份实例。
 *
 * 为什么必须有这一步：rich-markdown-editor@11.21.3 把 prosemirror-view / prosemirror-transform
 * 钉成精确版本，而我们的自定义扩展也会 import prosemirror-state / prosemirror-view。
 * 一旦出现两份副本，PluginKey 身份与 instanceof 检查会静默失效——表现就是"扩展没反应"，
 * 极难排查。这里读 esbuild metafile，按 pnpm 的 .pnpm/<pkg>@<version>/ 路径统计版本数。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGES = ['prosemirror-model', 'prosemirror-state', 'prosemirror-view', 'prosemirror-transform'];
const METAFILES = ['dist/meta/webview.json', 'dist/meta/mermaid.json'];

/** @type {Map<string, Set<string>>} */
const seen = new Map(PACKAGES.map((p) => [p, new Set()]));
let inputs = 0;

for (const rel of METAFILES) {
  const file = path.join(root, rel);
  if (!existsSync(file)) continue;
  const meta = JSON.parse(await readFile(file, 'utf8'));
  for (const input of Object.keys(meta.inputs ?? {})) {
    inputs++;
    for (const pkg of PACKAGES) {
      const m = input.match(new RegExp(`(?:^|/)(?:\\.pnpm/${pkg}@([^/]+)/|node_modules/${pkg}/)`));
      if (m) seen.get(pkg).add(m[1] ?? '(hoisted)');
    }
  }
}

if (inputs === 0) {
  console.error('[check-single-prosemirror] 没找到 metafile，先跑一次 node esbuild.mjs');
  process.exit(1);
}

let failed = false;
for (const pkg of PACKAGES) {
  const versions = [...seen.get(pkg)];
  if (versions.length > 1) {
    console.error(`[check-single-prosemirror] ✖ ${pkg} 出现了 ${versions.length} 份：${versions.join(', ')}`);
    failed = true;
  } else {
    console.log(`[check-single-prosemirror] ✓ ${pkg} ${versions[0] ?? '(未被打进 bundle)'}`);
  }
}

if (failed) {
  console.error('[check-single-prosemirror] 请用 pnpm.overrides 把版本钉成一份。');
  process.exit(1);
}
