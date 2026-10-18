import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const required = ['index.html', 'src/main.js', 'src/logic.js', 'src/styles.css', 'src-tauri/src/main.rs', 'rust-toolchain.toml', 'README.md'];
const failures = [];

for (const relative of required) {
  try {
    const content = await readFile(join(root, relative), 'utf8');
    if (!content.trim()) failures.push(`${relative} is empty`);
  } catch {
    failures.push(`${relative} is missing`);
  }
}

const html = await readFile(join(root, 'index.html'), 'utf8');
const main = await readFile(join(root, 'src/main.js'), 'utf8');
if (!html.includes('src/main.js')) failures.push('index.html does not load the application entry point');
if (!main.includes('startRecording') || !main.includes('retryPendingJobs')) failures.push('core recording/retry flow is missing');

if (failures.length) {
  console.error(failures.map((failure) => `✗ ${failure}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`✓ ${required.length} required project files are present`);
}
