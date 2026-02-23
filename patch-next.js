const fs = require('fs');

// Patch 1: generate-build-id guard
const gbid = 'node_modules/next/dist/build/generate-build-id.js';
let src1 = fs.readFileSync(gbid, 'utf8');
if (src1.indexOf('typeof generate') === -1) {
  src1 = src1.replace('let buildId = await generate();', 'let buildId = typeof generate === "function" ? await generate() : null;');
  fs.writeFileSync(gbid, src1);
  console.log('Patched generate-build-id');
} else {
  console.log('generate-build-id: already patched');
}

// Patch 2: export/index.js — htmlLimitedBots?.source (Next.js 15.5.x bug)
const exportIdx = 'node_modules/next/dist/export/index.js';
let src2 = fs.readFileSync(exportIdx, 'utf8');
const broken = 'htmlLimitedBots: nextConfig.htmlLimitedBots.source,';
const fixed  = 'htmlLimitedBots: nextConfig.htmlLimitedBots?.source,';
if (src2.includes(fixed)) {
  console.log('export/index.js: already patched');
} else if (src2.includes(broken)) {
  src2 = src2.replace(broken, fixed);
  fs.writeFileSync(exportIdx, src2);
  console.log('Patched export/index.js');
} else {
  console.log('export/index.js: pattern not found, skipping');
}
