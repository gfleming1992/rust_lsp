#!/usr/bin/env node
/**
 * Test script for DRC (Design Rule Check) performance
 * Usage: node tools/test_drc.mjs tests/tinytapeout-demo.xml
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const xmlFile = process.argv[2] || 'tests/tinytapeout-demo.xml';
const lspServerPath = path.join(__dirname, '..', 'target', 'release', 'lsp_server.exe');

console.log(`Testing DRC with: ${xmlFile}`);
console.log(`LSP Server: ${lspServerPath}`);

let requestId = 1;

function makeRequest(method, params = {}) {
    return JSON.stringify({
        id: requestId++,
        method,
        params
    });
}

async function main() {
    // Start the LSP server
    const lsp = spawn(lspServerPath, [], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    const rl = createInterface({
        input: lsp.stdout,
        crlfDelay: Infinity
    });

    const responses = [];
    rl.on('line', (line) => {
        try {
            const json = JSON.parse(line);
            responses.push(json);
            console.log(`[Response] ${JSON.stringify(json).substring(0, 200)}...`);
        } catch (e) {
            console.log(`[LSP stderr/other] ${line}`);
        }
    });

    lsp.stderr.on('data', (data) => {
        console.log(`[LSP stderr] ${data.toString()}`);
    });

    // Wait for the server to start
    await new Promise(resolve => setTimeout(resolve, 500));

    // 1. Load the file
    console.log('\n=== Loading file ===');
    const loadStart = performance.now();
    lsp.stdin.write(makeRequest('Load', { file_path: path.resolve(xmlFile) }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for load
    console.log(`Load completed in ${(performance.now() - loadStart).toFixed(0)}ms`);

    // 2. Run DRC
    console.log('\n=== Running DRC ===');
    const drcStart = performance.now();
    lsp.stdin.write(makeRequest('RunDRC', { clearance_mm: 0.15 }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 30000)); // Wait for DRC (may take longer)
    console.log(`DRC completed in ${(performance.now() - drcStart).toFixed(0)}ms`);

    // 3. Get violations
    console.log('\n=== Getting DRC Violations ===');
    lsp.stdin.write(makeRequest('GetDRCViolations') + '\n');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 4. Close
    lsp.stdin.write(makeRequest('Close') + '\n');
    await new Promise(resolve => setTimeout(resolve, 500));

    // Kill the server
    lsp.kill();

    console.log('\n=== Test Complete ===');
    console.log(`Total responses received: ${responses.length}`);
}

main().catch(console.error);
