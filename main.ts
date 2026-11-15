// Driver for the markdown-render-speed-02 entry.
//
// The harness runs this file with node22: it reads every case from
// /input/cases.json (or MAKEFUN_INPUT_DIR), renders each case alone with
// parse() from ./parse.js, and writes the resulting HTML strings, in
// order, to /output/html.json (or MAKEFUN_OUTPUT_DIR). One parse() call
// per case, so no state carries over between cases.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = new Array(cases.length);
for (let i = 0; i < cases.length; i += 1) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
