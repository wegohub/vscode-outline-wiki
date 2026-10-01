import { build, context } from 'esbuild';
import { buildNativeMedia } from './scripts/build-native-media.mjs';
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
buildNativeMedia(root);
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const define = {
  'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
  global: 'globalThis'
};

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  legalComments: 'none',
  metafile: true
};

/** @type {{name: string, metaOut?: string, options: import('esbuild').BuildOptions}[]} */
const targets = [
  {
    name: 'extension',
    metaOut: 'dist/meta/extension.json',
    options: {
      entryPoints: [path.join(root, 'src/extension/extension.ts')],
      outfile: path.join(root, 'dist/extension.js'),
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['vscode'],
      ...common
    }
  },
  {
    name: 'webview',
    metaOut: 'dist/meta/webview.json',
    options: {
      entryPoints: [path.join(root, 'src/webview/main.tsx')],
      outfile: path.join(root, 'dist/webview/main.js'),
      // webview 是不透明源：必须是单文件 iife，不能用 dynamic import
      platform: 'browser',
      format: 'iife',
      target: 'chrome120',
      define,
      loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
      ...common
    }
  }
];

// mermaid 懒加载 chunk：只有存在源文件时才构建，用 <script src=asWebviewUri(...)> 注入
const mermaidEntry = path.join(root, 'src/webview/extensions/mermaid-chunk.ts');
if (existsSync(mermaidEntry)) {
  targets.push({
    name: 'mermaid',
    metaOut: 'dist/meta/mermaid.json',
    options: {
      entryPoints: [mermaidEntry],
      outfile: path.join(root, 'dist/webview/mermaid.js'),
      platform: 'browser',
      format: 'iife',
      target: 'chrome120',
      define,
      ...common
    }
  });
}

// 集成测试：node + cjs，vscode/mocha 由测试宿主提供
if (process.argv.includes('--tests')) {
  targets.push({
    name: 'tests',
    options: {
      entryPoints: [path.join(root, 'test/integration/index.ts'), path.join(root, 'test/integration/suites.ts')],
      outdir: path.join(root, 'dist/test'),
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['vscode', 'mocha'],
      sourcemap: true,
      bundle: true,
      legalComments: 'none'
    }
  });
}

async function writeMeta(metaOut, metafile) {
  const file = path.join(root, metaOut);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(metafile));
}

async function copyAssets() {
  const distWebview = path.join(root, 'dist/webview');
  await mkdir(distWebview, { recursive: true });
  await cp(path.join(root, 'media/webview.css'), path.join(distWebview, 'webview.css'));

  // KaTeX：CSS 里的 url(fonts/...) 依赖同目录结构，必须一起复制
  const katexDist = path.join(root, 'node_modules/katex/dist');
  if (existsSync(katexDist)) {
    await rm(path.join(distWebview, 'katex'), { recursive: true, force: true });
    await mkdir(path.join(distWebview, 'katex'), { recursive: true });
    await cp(path.join(katexDist, 'katex.min.css'), path.join(distWebview, 'katex/katex.min.css'));
    await cp(path.join(katexDist, 'fonts'), path.join(distWebview, 'katex/fonts'), { recursive: true });
  }
}

async function run() {
  await mkdir(path.join(root, 'dist/meta'), { recursive: true });

  if (watch) {
    const contexts = await Promise.all(
      targets.map(async (target) => {
        const ctx = await context(target.options);
        await ctx.watch();
        return { target, ctx };
      })
    );
    await copyAssets();
    // 首次构建完成后写一次 metafile，供 check-single-prosemirror 用
    setTimeout(async () => {
      for (const { target, ctx } of contexts) {
        if (!target.metaOut) continue;
        try {
          const result = await ctx.rebuild();
          if (result.metafile) await writeMeta(target.metaOut, result.metafile);
        } catch {
          /* 忽略：watch 模式下构建失败会由 esbuild 自己报错 */
        }
      }
    }, 1500);
    console.log('[esbuild] watching…');
    return;
  }

  for (const target of targets) {
    const result = await build(target.options);
    if (target.metaOut && result.metafile) await writeMeta(target.metaOut, result.metafile);
  }
  await copyAssets();

  for (const rel of [
    'dist/extension.js',
    'dist/webview/main.js',
    'dist/webview/mermaid.js',
    'dist/webview/webview.css',
    'dist/webview/katex/katex.min.css'
  ]) {
    const file = path.join(root, rel);
    if (existsSync(file)) {
      const { size } = await stat(file);
      console.log(`[esbuild] ${rel}  ${(size / 1024).toFixed(1)} kB`);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
