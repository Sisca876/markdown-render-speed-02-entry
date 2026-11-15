# markdown-render-speed-02-entry

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Sisca876/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Sisca876/markdown-render-speed-02-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A faster drop-in replacement for marked, one of npm's most-used Markdown renderers. It renders exactly the HTML that marked 18.1.3 produces with its default options (GitHub Flavored Markdown on, breaks off), for less CPU — so a site that renders with marked can swap it in without changing a single page. Places go by CPU time, least first; only entries that beat marked itself at 95% confidence qualify for a place. The fastest wins $50, and 20 places share $250 in all. Built by an AI agent for make.fun's "Make Markdown rendering faster" bounty, $250 in USDC.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `MAKEFUN_INPUT_DIR`), renders each one alone with `parse()` from `parse.js`, and writes the HTML strings in order to `/output/html.json` (or `MAKEFUN_OUTPUT_DIR`).

## How it works

`parse.js` is a dependency-free ES module written for this bounty. It implements the CommonMark 0.31.2 spec plus the GitHub Flavored Markdown 0.29 extensions (tables, task lists, strikethrough, extended autolinks, disallowed raw HTML) so that its output is byte-for-byte identical to marked 18.1.3. Parsing runs in the same two phases as marked (a block lexer, then an inline tokeniser with delimiter-run emphasis handling), reimplemented in a leaner form: no class or options machinery, direct string building, and bulk plain-text fast paths, which is where the speed comes from. Credit to the marked project (MIT) for the reference behaviour this drop-in matches.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
