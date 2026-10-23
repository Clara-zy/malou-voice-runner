#!/usr/bin/env node
/**
 * 生成单文件离线版：把 style.css 和 js/*.js 全部内联进一个 HTML。
 * 产物 dist/malou-offline.html —— 双击即玩（file:// 打开，无需服务器、无需网络），
 * 适合 U 盘拷去现场兜底。
 *
 * 用法：node tools/build-offline.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let html = readFileSync(join(root, 'index.html'), 'utf8');

// 内联样式
html = html.replace(
  '<link rel="stylesheet" href="style.css">',
  () => '<style>\n' + readFileSync(join(root, 'style.css'), 'utf8') + '</style>'
);

// 内联全部脚本（按 index.html 中的出现顺序，保持依赖顺序）
html = html.replace(/<script src="[^"]+"><\/script>/g, (tag) => {
  const src = tag.match(/src="([^"]+)"/)[1];
  return '<script>\n' + readFileSync(join(root, src), 'utf8') + '\n</script>';
});

// PWA 清单在 file:// 下无意义，去掉避免控制台告警
html = html.replace('<link rel="manifest" href="manifest.webmanifest">', '<!-- 单文件离线版：已剥离 PWA 清单 -->');

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist/malou-offline.html');
writeFileSync(out, html);
console.log(`✅ ${out} (${(html.length / 1024).toFixed(1)} KB)`);
