#!/usr/bin/env node
/**
 * Print DRC violations in detail
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const xmlFile = process.argv[2] || 'tests/tinytapeout-demo.xml';
const lspServerPath = path.join(__dirname, '..', 'target', 'release', 'lsp_server.exe');

const lsp = spawn(lspServerPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
lsp.stderr.pipe(process.stderr);

let id = 1;
function send(method, params = {}) {
    lsp.stdin.write(JSON.stringify({id: id++, method, params}) + '\n');
}

let buffer = '';
lsp.stdout.on('data', data => {
    buffer += data.toString();
    let lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
        if (line.trim()) {
            try {
                const json = JSON.parse(line);
                if (json.id === 3) {
                    // Show first 10 violations
                    const violations = json.result.slice(0, 10);
                    console.log('\n=== First 10 DRC Violations ===');
                    violations.forEach((v, i) => {
                        console.log(`${i+1}. Layer: ${v.layer_id}`);
                        console.log(`   Distance: ${v.distance_mm.toFixed(4)}mm (clearance: ${v.clearance_mm.toFixed(2)}mm)`);
                        console.log(`   Net A: ${v.net_a || 'none'}, Net B: ${v.net_b || 'none'}`);
                        console.log(`   Point: [${v.point[0].toFixed(3)}, ${v.point[1].toFixed(3)}]`);
                        console.log(`   Objects: ${v.object_a_id} vs ${v.object_b_id}`);
                    });
                    console.log(`\nTotal violations: ${json.result.length}`);
                    lsp.kill();
                }
            } catch (e) {
                // Ignore parse errors
            }
        }
    }
});

setTimeout(() => send('Load', {file_path: path.resolve(xmlFile)}), 100);
setTimeout(() => send('RunDRC', {clearance_mm: 0.15}), 2000);
setTimeout(() => send('GetDRCViolations'), 5000);
setTimeout(() => lsp.kill(), 10000);
