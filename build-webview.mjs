/**
 * Build script for webview - bundles main.ts and binaryParserWorker.ts
 */
import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure output directory exists
const distDir = path.join(__dirname, 'webview', 'dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

console.log('[Build] Building webview bundles...');

// Build the worker separately (IIFE format for Web Workers)
await esbuild.build({
  entryPoints: ['webview/src/parsing/binaryParserWorker.ts'],
  bundle: true,
  outfile: 'webview/dist/binaryParserWorker.js',
  format: 'iife',
  sourcemap: true,
  target: 'es2020',
  minify: true,
  logLevel: 'info',
});

console.log('[Build] Worker bundle complete');

// Build the main bundle (IIFE format for better compatibility)
await esbuild.build({
  entryPoints: ['webview/src/main.ts'],
  bundle: true,
  outfile: 'webview/dist/main.js',
  format: 'iife',
  sourcemap: true,
  target: 'es2020',
  minify: true,
  logLevel: 'info',
  loader: {
    '.wgsl': 'text', // Load WGSL shader files as text
  },
});

console.log('[Build] Main bundle complete');
console.log('[Build] Webview build finished');
