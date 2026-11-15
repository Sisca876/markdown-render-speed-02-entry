// markdown-render-speed-02 — a dependency-free Markdown parser.
//
// The public entry point is parse(markdown): it returns the HTML that
// marked 18.1.3 (default options, GFM on) produces for the same input,
// byte for byte, over the competition's 720 cases (CommonMark 0.31.2 +
// GFM 0.29 + 40 long READMEs). The lexer is hand-written: a block pass
// tokenizes the source, then an inline pass renders each token. No
// dependencies, no runtime RegExp compilation in the hot path — the
// patterns are built once at module load.
//
// Origin: written from scratch for the make.fun bounty
// "markdown-render-speed-02". The reference behaviour (marked 18.1.3)
// is reproduced by re-implementing its token rules, not by importing it.
// The file is split into: helpers, block rules, inline rules, the two
// tokenizers, and the renderer. Read the per-function comments for the
// rule each piece implements.

// ---------------------------------------------------------------- helpers

const CARET = /(^|[^\[])\^/g;

// Small builder for regexes composed from parts, like marked's edit().
// Each replace() swaps one named placeholder for a pattern; get() builds
// the final regex. The CARET fixup keeps a `^` inside a substituted
// pattern anchored to the start of the whole regex.
function rx(src, flags = '') {
  let s = typeof src === 'string' ? src : src.source;
  const replace = (name, rep) => {
    const pat = typeof rep === 'string' ? rep : rep.source;
    s = s.replace(name, pat.replace(CARET, '$1'));
    return api;
  };
  const get = () => new RegExp(s, flags);
  const api = { replace, get };
  return api;
}

// Character classes for the scanners below, written out instead of
// leaning on regexes: the hot paths run these per character.
function isHexCode(c) {
  const isDigit = c >= 48 && c <= 57;
  const isUpperHex = c >= 65 && c <= 70;
  const isLowerHex = c >= 97 && c <= 102;
  return isDigit || isUpperHex || isLowerHex;
}
function hexValue(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  return c - 87;
}
function isWordCode(c) {
  const isAlnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return isAlnum || c === 95;
}

// Does a valid entity or character reference start at s[i] (where s[i]
// is '&')? A reference is `&#` + 1-7 decimal digits + `;`, `&#x`/`&#X` +
// 1-6 hex digits + `;`, or `&` + 1 or more word characters + `;`.
// This mirrors the lookahead marked's escape regexes use.
function looksLikeEntity(s, i) {
  let j = i + 1;
  if (s.charCodeAt(j) === 35) {
    j++;
    if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) {
      j++;
      const start = j;
      while (j < s.length && isHexCode(s.charCodeAt(j))) j++;
      return j > start && j <= start + 6 && s.charCodeAt(j) === 59;
    }
    const start = j;
    while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    return j > start && j <= start + 7 && s.charCodeAt(j) === 59;
  }
  const start = j;
  while (j < s.length && isWordCode(s.charCodeAt(j))) j++;
  return j > start && s.charCodeAt(j) === 59;
}

// Escape HTML in one scan. With encode set, every `&` is escaped; without
// it, an `&` that starts a valid entity or character reference is left
// alone. `<`, `>`, `"` and `'` are always escaped. When nothing needs
// escaping the input string itself is returned, untouched.
function escHtml(s, encode) {
  let out = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (encode || !looksLikeEntity(s, i)) rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (out === null) out = [];
      out.push(s.slice(start, i), rep);
      start = i + 1;
    }
  }
  if (out === null) return s;
  out.push(s.slice(start));
  return out.join('');
}

// Is there a decodable numeric reference anywhere in s? A reference is
// `&#` + 1-7 decimal digits + `;` or `&#x`/`&#X` + 1-6 hex digits + `;`.
// decodeNumericRefs leaves a string without one completely alone.
function hasNumericRef(s) {
  let i = s.indexOf('&#');
  while (i !== -1) {
    let j = i + 2;
    if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) {
      j++;
      const start = j;
      while (j < s.length && isHexCode(s.charCodeAt(j))) j++;
      if (j > start && j <= start + 6 && s.charCodeAt(j) === 59) return true;
    } else {
      const start = j;
      while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
      if (j > start && j <= start + 7 && s.charCodeAt(j) === 59) return true;
    }
    i = s.indexOf('&#', i + 2);
  }
  return false;
}

// Decode numeric character references only (named entities are left as-is,
// exactly like marked: they survive into the HTML and the browser decodes
// them there). A bare `&` that does not start a valid entity becomes
// `&amp;`, but only when the string holds a numeric reference at all —
// without one the string is returned unchanged.
function decodeNumericRefs(s) {
  if (!hasNumericRef(s)) return s;
  let out = null;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) !== 38) { i++; continue; }
    let j = i + 1;
    let code = -1;
    if (s.charCodeAt(j) === 35) {
      j++;
      if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) {
        j++;
        const begin = j;
        let value = 0;
        while (j < s.length && isHexCode(s.charCodeAt(j))) {
          value = value * 16 + hexValue(s.charCodeAt(j));
          j++;
        }
        if (j > begin && j <= begin + 6 && s.charCodeAt(j) === 59) code = value;
      } else {
        const begin = j;
        let value = 0;
        while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) {
          value = value * 10 + (s.charCodeAt(j) - 48);
          j++;
        }
        if (j > begin && j <= begin + 7 && s.charCodeAt(j) === 59) code = value;
      }
    }
    if (code >= 0) {
      let rep;
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) rep = '\uFFFD';
      else if (code === 38) rep = '&amp;';
      else rep = String.fromCodePoint(code);
      if (out === null) out = [];
      out.push(s.slice(start, i), rep);
      i = j + 1;
      start = i;
      continue;
    }
    if (!looksLikeEntity(s, i)) {
      if (out === null) out = [];
      out.push(s.slice(start, i), '&amp;');
      start = i + 1;
    }
    i++;
  }
  if (out === null) return s;
  out.push(s.slice(start));
  return out.join('');
}

// Encode a link destination the way marked does: encodeURI, with the
// `%25` sequences it produces for literal percent signs turned back into
// `%`. An href encodeURI rejects (a lone surrogate, for example) is null.
function encodeHref(href) {
  try {
    return encodeURI(href).replaceAll('%25', '%');
  } catch {
    return null;
  }
}

// Normalise a link reference label: trim it, collapse each run of
// whitespace to one space, then run it through lower case, upper case and
// lower case again (marked's exact quirk: the round trip matters for
// characters like the Kelvin sign).
function normLabel(s) {
  let out = '';
  let i = 0;
  let n = s.length;
  while (i < n && /\s/.test(s[i])) i++;
  while (n > i && /\s/.test(s[n - 1])) n--;
  let pendingSpace = false;
  for (; i < n; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out.length > 0) out += ' ';
    pendingSpace = false;
    out += ch;
  }
  const lowered = out.toLowerCase();
  return lowered.toUpperCase().toLowerCase();
}

const FIND_PIPE = new RegExp(String.raw`\|`, 'g');
const SPLIT_PIPE = new RegExp(String.raw` \|`);
const SLASH_PIPE = new RegExp(String.raw`\\\|`, 'g');
// Split a table row into cells, honouring escaped pipes. An escaped pipe
// (preceded by an odd run of backslashes) stays a literal pipe inside a
// cell; an unescaped pipe separates cells. Leading/trailing empty cells
// from the row's edge pipes are dropped.
function splitCells(row, count) {
  const t = row.replace(FIND_PIPE, (m, off, str) => {
    // Count the backslashes directly before this pipe; an odd count means
    // the pipe is escaped.
    let run = 0;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) run++;
    return run % 2 === 1 ? '|' : ' |';
  });
  const cells = t.split(SPLIT_PIPE);
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(SLASH_PIPE, '|');
  return cells;
}

// Expand tabs to spaces, tab stops every 4 columns from `startCol`.
// Columns count code points, not UTF-16 units, so an astral character
// before a tab takes one column, exactly like the original loop.
function expandTabs(s, startCol = 0) {
  if (!s.includes('\t')) return s;
  let col = startCol;
  const parts = [];
  let start = 0;
  let i = 0;
  for (const ch of s) {
    if (ch === '\t') {
      const width = 4 - (col % 4);
      parts.push(s.slice(start, i), ' '.repeat(width));
      col += width;
      start = i + 1;
    } else {
      col++;
    }
    i += ch.length;
  }
  parts.push(s.slice(start));
  return parts.join('');
}

// Is this line blank in the block sense: only spaces and tabs (an empty
// line counts as blank; other whitespace such as a vertical tab does not).
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Drop a run of trailing blank lines, keeping the string unchanged when
// there is at most one trailing blank line.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && isBlankLine(lines[last])) last--;
  if (lines.length - 1 - last <= 1) return s;
  return lines.slice(0, last + 1).join('\n');
}

// Strip trailing occurrences of `ch` (or, when invert, trailing chars
// different from `ch`).
function stripTail(s, ch, invert) {
  let end = s.length;
  if (invert) {
    while (end > 0 && s.charAt(end - 1) !== ch) end--;
  } else {
    while (end > 0 && s.charAt(end - 1) === ch) end--;
  }
  return s.slice(0, end);
}

// Balanced-paren scan used by link parsing: returns the index of the first
// unmatched closing paren, -2 when an opener is left unmatched, else -1.
// A backslash escapes the next character, so it never counts as a paren.
function parenScan(s, open, close) {
  const openCode = open.charCodeAt(0);
  const closeCode = open.charCodeAt(1);
  if (s.indexOf(open[0]) < 0 && s.indexOf(open[1]) < 0) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) { i++; continue; }
    if (c === openCode) depth++;
    else if (c === closeCode) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// ---------------------------------------------------------------- regexes

const BLOCK_TAGS = String.raw`address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul`;

// Cache a factory's regexes by argument (the indent factories are only
// ever called with a handful of values, so this stays tiny).
function memoRegex(fn) {
  const cache = new Map();
  return (key) => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const made = fn(key);
    cache.set(key, made);
    return made;
  };
}

// marked's D() memoiser clamps the indent argument to [0, 3] of (t - 1).
function clampIndent(indent) {
  return Math.max(0, Math.min(3, indent - 1));
}

const O = {
  codeRemoveIndent: new RegExp(String.raw`^(?: {0,3}\t| {1,4})`, 'gm'),
  outputLinkReplace: new RegExp(String.raw`\\([\[\]])`, 'g'),
  indentCodeCompensation: new RegExp(String.raw`^(\s+)(?:\x60\x60\x60)`),
  beginningSpace: new RegExp(String.raw`^\s+`),
  endingHash: new RegExp(String.raw`#$`),
  startingSpaceChar: new RegExp(String.raw`^ `),
  endingSpaceChar: new RegExp(String.raw` $`),
  endingSpaceTabChar: new RegExp(String.raw`[ \t]$`),
  nonSpaceChar: new RegExp(String.raw`[^ ]`),
  newLineCharGlobal: new RegExp(String.raw`\n`, 'g'),
  tabCharGlobal: new RegExp(String.raw`\t`, 'g'),
  leadingSpaceTab: new RegExp(String.raw`^[ \t]+`),
  multipleSpaceGlobal: new RegExp(String.raw`\s+`, 'g'),
  blankLine: new RegExp(String.raw`^[ \t]*$`),
  doubleBlankLine: new RegExp(String.raw`\n[ \t]*\n[ \t]*$`),
  blockquoteStart: new RegExp(String.raw`^ {0,3}>`),
  blockquoteSetextReplace: new RegExp(String.raw`\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)`, 'g'),
  blockquoteSetextReplace2: new RegExp(String.raw`^ {0,3}>[ \t]?`, 'gm'),
  blockquoteMarkerWhitespace: new RegExp(String.raw`^( {0,3}>)([ \t]+)`, 'gm'),
  listReplaceNesting: new RegExp(String.raw`^ {1,4}(?=( {4})*[^ ])`, 'g'),
  listIsTask: new RegExp(String.raw`^\[[ xX]\][ \t]+\S`),
  listReplaceTask: new RegExp(String.raw`^\[[ xX]\][ \t]+`),
  listTaskCheckbox: new RegExp(String.raw`\[[ xX]\]`),
  anyLine: new RegExp(String.raw`\n.*\n`),
  hrefBrackets: new RegExp(String.raw`^<(.*)>$`),
  tableDelimiter: new RegExp(String.raw`[:|]`),
  tableAlignChars: new RegExp(String.raw`^\||\| *$`, 'g'),
  tableRowBlankLine: new RegExp(String.raw`\n[ \t]*$`),
  tableAlignRight: new RegExp(String.raw`^ *-+: *$`),
  tableAlignCenter: new RegExp(String.raw`^ *:-+: *$`),
  tableAlignLeft: new RegExp(String.raw`^ *:-+ *$`),
  startATag: new RegExp(String.raw`^<a `, 'i'),
  endATag: new RegExp(String.raw`^<\/a>`, 'i'),
  startPreScriptTag: new RegExp(String.raw`^<(pre|code|kbd|script)(\s|>)`, 'i'),
  endPreScriptTag: new RegExp(String.raw`^<\/(pre|code|kbd|script)(\s|>)`, 'i'),
  startAngleBracket: new RegExp(String.raw`^<`),
  endAngleBracket: new RegExp(String.raw`>$`),
  unicodeAlphaNumeric: new RegExp(String.raw`[\p{L}\p{N}]`, 'u'),
  percentDecode: new RegExp(String.raw`%25`, 'g'),
  findPipe: new RegExp(String.raw`\|`, 'g'),
  splitPipe: new RegExp(String.raw` \|`),
  slashPipe: new RegExp(String.raw`\\\|`, 'g'),
  carriageReturn: new RegExp(String.raw`\r\n|\r`, 'g'),
  spaceLine: new RegExp(String.raw`^ +$`, 'gm'),
  notSpaceStart: new RegExp(String.raw`^\S*`),
  endingNewline: new RegExp(String.raw`\n$`),
  listItemRegex: memoRegex((bull) => new RegExp(`^( {0,3}${bull})((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  nextBulletRegex: memoRegex((indent) => new RegExp(`^ {0,${clampIndent(indent)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: memoRegex((indent) => new RegExp(`^ {0,${clampIndent(indent)}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: memoRegex((indent) => new RegExp(`^ {0,${clampIndent(indent)}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: memoRegex((indent) => new RegExp(`^ {0,${clampIndent(indent)}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: memoRegex((indent) => new RegExp(`^ {0,${clampIndent(indent)}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: memoRegex((indent) => new RegExp(`^ {0,${clampIndent(indent)}}>`)),
};

const BULLET = new RegExp(String.raw` {0,3}(?:[*+-]|\d{1,9}[.)])`);
const HR_SRC = new RegExp(String.raw`^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)`);
const HEADING_SRC = String.raw` {0,3}#{1,6}(?:\s|$)`;
const HTML_OPEN_SRC = String.raw` {0,3}(?:</?(?:tag)(?: +|\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)`;
const FENCES_SRC = String.raw` {0,3}(?:\x60{3,}(?=[^\x60\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)`;
const BLOCKQUOTE_SRC = String.raw` {0,3}>`;

// Block paragraph core: a run of lines that does not start a new block.
const PARA_CORE = new RegExp(
  String.raw`^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)`,
);

// Setext heading (lheading) core, with placeholders replaced per ruleset.
const LHEADING_CORE = new RegExp(
  String.raw`^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)`,
);

// GFM table.
const TABLE_SRC = String.raw`^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|hr|heading|blockquote|code|fences|list|html).*(?:\n|$))*)\n*|$)`;


// HTML comment.
const HTML_COMMENT = new RegExp(String.raw`<!--(?:-?>|[\s\S]*?(?:-->|$))`);

// Block HTML (type 1-7), GFM.
const BLOCK_HTML = rx(
  String.raw`^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:</\1>[^\n]*\n*|$)|comment[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|</?(tag)(?:[ \t]+|\n|/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|</[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))`,
  'i',
)
  .replace('comment', HTML_COMMENT)
  .replace('tag', BLOCK_TAGS)
  .replace(
    'attribute',
    new RegExp(String.raw` +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>\x60]+)?`),
  )
  .get();

// Link reference definition label / title pieces.
const LABEL_INNER = new RegExp(String.raw`(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+`);
const TITLE_RE = new RegExp(String.raw`(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))`);
const DEF_RE = rx(
  String.raw`^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)`,
)
  .replace('label', LABEL_INNER)
  .replace('title', TITLE_RE)
  .get();

// Apply a list of [name, pattern] substitutions to a regex source and
// build the resulting regex.
function subAll(source, subs) {
  let r = rx(source);
  for (const [name, pat] of subs) r = r.replace(name, pat);
  return r.get();
}

function buildBlockRules() {
  const lheading = subAll(LHEADING_CORE, [
    [new RegExp(String.raw`bull`, 'g'), BULLET],
    [new RegExp(String.raw`blockCode`, 'g'), new RegExp(String.raw`(?: {4}| {0,3}\t)`)],
    [new RegExp(String.raw`fences`, 'g'), new RegExp(String.raw` {0,3}(?:\x60{3,}|~{3,})`)],
    [new RegExp(String.raw`blockquote`, 'g'), new RegExp(String.raw` {0,3}>`)],
    [new RegExp(String.raw`heading`, 'g'), HEADING_SRC],
    [
      new RegExp(String.raw`hr`, 'g'),
      new RegExp(String.raw` {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)`),
    ],
    [new RegExp(String.raw`html`, 'g'), new RegExp(String.raw` {0,3}<[^\n>]+>\n`)],
    [new RegExp(String.raw`table`, 'g'), new RegExp(String.raw` {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n`)],
  ]);
  const table = subAll(TABLE_SRC, [
    ['hr', HR_SRC],
    ['heading', HEADING_SRC],
    ['blockquote', BLOCKQUOTE_SRC],
    ['code', /(?: {4}| {0,3}\t)[^\n]/],
    ['fences', FENCES_SRC],
    ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
    ['html', HTML_OPEN_SRC],
    ['tag', BLOCK_TAGS],
  ]);
  const paragraph = subAll(PARA_CORE, [
    ['hr', HR_SRC],
    ['heading', HEADING_SRC],
    ['|lheading', ''],
    ['table', table],
    ['blockquote', BLOCKQUOTE_SRC],
    ['fences', FENCES_SRC],
    ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]'],
    ['html', HTML_OPEN_SRC],
    ['tag', BLOCK_TAGS],
  ]);
  const blockquote = subAll(
    /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
    [['paragraph', paragraph]],
  );
  return {
    newline: new RegExp(String.raw`^(?:[ \t]*(?:\n|$))+`),
    code: new RegExp(String.raw`^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+`),
    fences: new RegExp(
      String.raw`^ {0,3}(\x60{3,}(?=[^\x60\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=\x60)\1\x60*|(?=~)\1~*) *(?=\n|$)|$)`,
    ),
    heading: new RegExp(String.raw`^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)`),
    hr: HR_SRC,
    blockquote,
    list: subAll(new RegExp(String.raw`^(bull)([ \t][^\n]*?)?(?:\n|$)`), [
      [new RegExp(String.raw`bull`, 'g'), BULLET],
    ]),
    html: BLOCK_HTML,
    def: DEF_RE,
    table,
    lheading,
    paragraph,
    text: new RegExp(String.raw`^[^\n]+`),
  };
}

const BLOCK = buildBlockRules();

// ---------------------------------------------------------------- inline regexes

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = new RegExp(String.raw`[^\s\p{P}\p{S}]`, 'u');
const PUNCT_NOT_TILDE = new RegExp(String.raw`(?!~)[\p{P}\p{S}]`, 'u');
const PUNCT_SPACE_NOT_TILDE = new RegExp(String.raw`(?!~)[\s\p{P}\p{S}]`, 'u');
const NOT_PUNCT_SPACE_OR_TILDE = new RegExp(String.raw`(?:[^\s\p{P}\p{S}]|~)`, 'u');
const OPEN_QUOTE = new RegExp(String.raw`[\p{Pi}\p{Ps}"']`, 'u');

const INLINE = {
  escape: new RegExp(String.raw`^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_\x60{|}~])`),
  code: new RegExp(String.raw`^(\x60+)([^\x60]|[^\x60][\s\S]*?[^\x60])\1(?!\x60)`),
  br: new RegExp(String.raw`^( {2,}|\\` + String.raw`)\n(?!\s*$)[ \t]*`),
  text: null, // built below (needs url pieces)
  autolink: rx(String.raw`^<(scheme:[^\s\x00-\x1f<>]*|email)>`)
    .replace('scheme', new RegExp(String.raw`[a-zA-Z][a-zA-Z0-9+.-]{1,31}`))
    .replace(
      'email',
      new RegExp(String.raw`[a-zA-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])`),
    )
    .get(),
  tag: rx(
    String.raw`^comment|^</[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\s*/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>`,
  )
    .replace('comment', rx(HTML_COMMENT).replace('(?:-->|$)', '-->').get())
    .replace(
      'attribute',
      new RegExp(String.raw`\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>\x60]+)?`),
    )
    .get(),
  link: null,
  reflink: null,
  nolink: null,
  emStrongLDelim: rx(String.raw`^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?`, 'u')
    .replace(new RegExp(String.raw`punct`, 'g'), PUNCT_NOT_TILDE)
    .get(),
  emStrongRDelimAst: rx(
    String.raw`^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)punct(\*+)(?=[\s]|$)|notPunctSpace(\*+)(?!\*)(?=punctSpace|$)|(?!\*)punctSpace(\*+)(?=notPunctSpace)|[\s](\*+)(?!\*)(?=punct)|(?!\*)punct(\*+)(?!\*)(?=punct)|notPunctSpace(\*+)(?=notPunctSpace)`,
    'gu',
  )
    .replace(new RegExp(String.raw`notPunctSpace`, 'g'), NOT_PUNCT_SPACE_OR_TILDE)
    .replace(new RegExp(String.raw`punctSpace`, 'g'), PUNCT_SPACE_NOT_TILDE)
    .replace(new RegExp(String.raw`punct`, 'g'), PUNCT_NOT_TILDE)
    .get(),
  emStrongRDelimUnd: rx(
    String.raw`^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)`,
    'gu',
  )
    .replace(new RegExp(String.raw`notPunctSpace`, 'g'), NOT_PUNCT_SPACE_OR_TILDE)
    .replace(new RegExp(String.raw`punctSpace`, 'g'), PUNCT_SPACE_NOT_TILDE)
    .replace(new RegExp(String.raw`punct`, 'g'), PUNCT_NOT_TILDE)
    .get(),
  delLDelim: rx(String.raw`^~~?(?:((?!~)punct)|[^\s~])`, 'u').replace(new RegExp(String.raw`punct`, 'g'), PUNCT).get(),
  delRDelim: rx(
    String.raw`^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)`,
    'gu',
  )
    .replace(new RegExp(String.raw`notPunctSpace`, 'g'), NOT_PUNCT_SPACE)
    .replace(new RegExp(String.raw`punctSpace`, 'g'), PUNCT_SPACE)
    .replace(new RegExp(String.raw`punct`, 'g'), PUNCT)
    .get(),
  url: null,
  backpedal: new RegExp(String.raw`(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+`),
  anyPunct: rx(String.raw`\\(punct)`, 'gu').replace(new RegExp(String.raw`punct`, 'g'), PUNCT).get(),
  anyPunctOutsideCode: rx(String.raw`(\x60+)(?:[^\x60]|[^\x60][\s\S]*?[^\x60])\1(?!\x60)|\x60+|\\(punct)`, 'gu')
    .replace(new RegExp(String.raw`punct`, 'g'), PUNCT)
    .get(),
  blockSkip: rx(String.raw`link|precode-code|html`, 'g')
    .replace(
      'link',
      new RegExp(String.raw`\[(?:[^\[\]\x60]|(?<a>\x60+)[^\x60]+\k<a>(?!\x60))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)`),
    )
    .replace('precode-', '(?<!`)()')
    .replace('code', new RegExp(String.raw`(?<b>\x60+)[^\x60]+\k<b>(?!\x60)`))
    .replace('html', new RegExp(String.raw`<(?! )[^<>]*?>`))
    .get(),
  reflinkSearch: null,
  punctuation: rx(String.raw`^((?![*_])punctSpace)`, 'u').replace(new RegExp(String.raw`punctSpace`, 'g'), PUNCT_SPACE).get(),
};

const EMAIL_RE = new RegExp(
  String.raw`[a-zA-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])`,
);
const EMAIL_SIMPLE = new RegExp(
  String.raw`[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])`,
);
const EMAIL_SIMPLE_GRP = new RegExp(
  String.raw`[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])`,
);
const PROTOCOL_RE = new RegExp(String.raw`[hH][tT][tT][pP][sS]?|[fF][tT][pP]`);
const MAILTO_RE = rx(String.raw`(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)`)
  .replace(new RegExp(String.raw`email`, 'g'), EMAIL_SIMPLE)
  .get();

const LINK_LABEL = rx(String.raw`(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|\x60+(?!\x60)[^\x60]*?\x60+(?!\x60)|\x60\x60+(?=\])|[^\[\]\\\x60])*?`)
  .replace('brackets', new RegExp(String.raw`\[(?:\\[\s\S]|[^\[\]\\])*\]`))
  .get();
const REF_LABEL = new RegExp(String.raw`(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+`);

INLINE.link = rx(String.raw`^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)`)
  .replace('label', LINK_LABEL)
  .replace('href', new RegExp(String.raw`<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))`))
  .replace('title', new RegExp(String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)`))
  .get();
INLINE.reflink = rx(String.raw`^!?\[(label)\]\[(ref)\]`)
  .replace('label', LINK_LABEL)
  .replace('ref', REF_LABEL)
  .get();
INLINE.nolink = rx(String.raw`^!?\[(ref)\](?:\[\])?`).replace('ref', REF_LABEL).get();
INLINE.url = rx(String.raw`^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email`)
  .replace('emailProtocol', MAILTO_RE)
  .replace('protocol', PROTOCOL_RE)
  .replace('email', EMAIL_SIMPLE_GRP)
  .get();

const REFLINK_SEARCH = (() => {
  const refInner = rx(String.raw`(?:[^\[\]\\\x60]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|\x60+(?!\x60)[^\x60]*?\x60+(?!\x60)|\x60\x60+(?=\]))){0,999}?[^\[\]\\\x60]*?`)
    .replace('brackets', new RegExp(String.raw`\[(?:\\[\s\S]|[^\[\]\\])*\]`))
    .get();
  const reflinkPat = rx(String.raw`^!?\[(label)\]\[(ref)\]`)
    .replace('label', refInner)
    .replace('ref', new RegExp(String.raw`(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})`))
    .get();
  const nolinkPat = rx(String.raw`^!?\[(ref)\](?:\[\])?`)
    .replace('ref', new RegExp(String.raw`(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})`))
    .get();
  return rx(String.raw`reflink|nolink(?!\()`, 'g')
    .replace('reflink', reflinkPat)
    .replace('nolink', nolinkPat)
    .get();
})();
INLINE.reflinkSearch = REFLINK_SEARCH;

// Inline text: consumes a run of plain text, stopping before markup.
INLINE.text = rx(
  String.raw`^(?:[^a-zA-Z0-9](?=emailProtocol)|(\x60+|~+|[^\x60~])(?:(?=[\x60~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_\x60{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[\x60*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_\x60{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_\x60{\|}~-]+@))))`,
)
  .replace('protocol', PROTOCOL_RE)
  .replace(new RegExp(String.raw`emailProtocol`, 'g'), new RegExp(String.raw`(?:mailto|xmpp):`))
  .replace('wwwStart', String.raw`(?<![^\s*_~(])www\.`)
  .get();

// ---------------------------------------------------------------- block lexer

// Per-parse lexer state. Fresh for every parse() call: nothing is kept
// from one case to the next.
function newLexer() {
  const lx = {};
  lx.tokens = [];
  lx.links = Object.create(null);
  lx.linkCount = 0;
  lx.inlineQueue = [];
  lx.inLink = false;
  lx.inRawBlock = false;
  lx.linkEmitted = false;
  lx.linkParenPossible = true;
  lx.top = true;
  lx.emStack = [];
  return lx;
}

// Queue inline tokenisation of `src` into `tokens` (done after the block
// pass, like marked, so link definitions anywhere in the document apply).
function queueInline(lx, src, tokens) {
  const item = { src, tokens };
  lx.inlineQueue.push(item);
  return tokens;
}

function tokSpace(src) {
  const m = BLOCK.newline.exec(src);
  if (m === null || m[0].length === 0) return null;
  return { type: 'space', raw: m[0] };
}

function tokCode(src) {
  const m = BLOCK.code.exec(src);
  if (m === null) return null;
  const raw = trimBlankTail(m[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(O.codeRemoveIndent, '') };
}

function tokFences(src) {
  const m = BLOCK.fences.exec(src);
  if (m === null) return null;
  const raw = m[0];
  let text = m[3] || '';
  const indentMatch = raw.match(O.indentCodeCompensation);
  if (indentMatch !== null) {
    const ind = indentMatch[1].length;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const sp = lines[i].match(O.beginningSpace);
      if (sp !== null) lines[i] = lines[i].slice(Math.min(sp[0].length, ind));
    }
    text = lines.join('\n');
  }
  const lang = m[2] ? m[2].trim().replace(INLINE.anyPunct, '$1') : m[2];
  return { type: 'code', raw, lang, text };
}

function tokHeading(lx, src) {
  const m = BLOCK.heading.exec(src);
  if (m === null) return null;
  let text = m[2].trim();
  if (O.endingHash.test(text)) {
    const stripped = stripTail(text, '#');
    if (stripped === '' || O.endingSpaceTabChar.test(stripped)) text = stripped.trim();
  }
  return {
    type: 'heading',
    raw: stripTail(m[0], '\n'),
    depth: m[1].length,
    text,
    tokens: queueInline(lx, text, []),
  };
}

function tokHr(src) {
  const m = BLOCK.hr.exec(src);
  if (m === null) return null;
  return { type: 'hr', raw: stripTail(m[0], '\n') };
}

// Split the remaining lines into the leading run of blockquote lines
// (plus any non-marker lines before the first marker) and the rest.
function blockquoteChunk(rest) {
  const chunk = [];
  let p = 0;
  let found = false;
  for (; p < rest.length; p++) {
    if (O.blockquoteStart.test(rest[p])) {
      chunk.push(rest[p]);
      found = true;
    } else if (!found) {
      chunk.push(rest[p]);
    } else break;
  }
  return [chunk, rest.slice(p)];
}

// Remove the `>` markers (and the setext compensation) from a chunk.
function stripBlockquoteMarkers(joined) {
  return joined
    .replace(O.blockquoteMarkerWhitespace, (g, mark, ws) => mark + expandTabs(ws, mark.length))
    .replace(O.blockquoteSetextReplace, '\n    $1')
    .replace(O.blockquoteSetextReplace2, '');
}

// A blockquote token that is itself a blockquote may swallow following
// lines: rebuild it from the merged text and consume what it took.
// Returns the updated accumulators plus the action the loop should take.
function absorbNestedBlockquote(lx, tokens, rest, rawAll, textAll) {
  const inner = tokens[tokens.length - 1];
  const tail = rest.join('\n');
  const merged = inner.raw + '\n' + tail.replace(O.blockquoteSetextReplace2, '');
  const rebuilt = tokBlockquote(lx, merged);
  tokens[tokens.length - 1] = rebuilt;
  const after = merged.substring(rebuilt.raw.length).replace(/^\n/, '');
  const afterLines = after === '' ? 0 : after.split('\n').length;
  const consumed = afterLines === 0 ? rest : rest.slice(0, -afterLines);
  if (consumed.length > 0) {
    rawAll = rawAll + '\n' + consumed.join('\n');
  }
  textAll = textAll.substring(0, textAll.length - inner.text.length) + rebuilt.text;
  rest = rest.slice(consumed.length);
  if (rest.length > 0 && O.blockquoteStart.test(rest[0])) {
    return { rawAll, textAll, rest, action: 'continue' };
  }
  return { rawAll, textAll, rest, action: 'break' };
}

// A list token inside a blockquote may swallow following lines the same way.
function absorbNestedList(lx, tokens, rest, rawAll, textAll) {
  const inner = tokens[tokens.length - 1];
  const tail = rest.join('\n');
  const merged = inner.raw + '\n' + tail;
  const rebuilt = tokList(lx, merged);
  tokens[tokens.length - 1] = rebuilt;
  const extra = rebuilt.raw.length > inner.raw.length
    ? merged.slice(inner.raw.length + 1, rebuilt.raw.length).split('\n').length
    : 0;
  if (extra > 0) {
    const extraText = rest.slice(0, extra).join('\n');
    rawAll = rawAll + '\n' + extraText;
    textAll = textAll + '\n' + extraText;
  }
  rest = rest.slice(extra);
  return { rawAll, textAll, rest, action: 'continue' };
}

function tokBlockquote(lx, src) {
  const m = BLOCK.blockquote.exec(src);
  if (m === null) return null;
  const lines = stripTail(m[0], '\n').split('\n');
  let rawAll = '';
  let textAll = '';
  const tokens = [];
  let rest = lines;
  for (;;) {
    const [chunk, next] = blockquoteChunk(rest);
    rest = next;
    const joined = chunk.join('\n');
    const stripped = stripBlockquoteMarkers(joined);
    rawAll = rawAll === '' ? joined : rawAll + '\n' + joined;
    textAll = textAll === '' ? stripped : textAll + '\n' + stripped;
    const savedTop = lx.top;
    lx.top = true;
    blockTokens(lx, stripped, tokens, true);
    lx.top = savedTop;
    if (rest.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last === undefined) continue;
    const lt = last.type;
    // A code/heading/hr/html/table token ends the blockquote outright.
    if (lt === 'code' || lt === 'heading' || lt === 'hr' || lt === 'html' || lt === 'table') break;
    // A nested blockquote or list may swallow the following lines, so
    // rebuild it from the merged text and consume what it took.
    if (lt === 'blockquote') {
      const out = absorbNestedBlockquote(lx, tokens, rest, rawAll, textAll);
      rawAll = out.rawAll;
      textAll = out.textAll;
      rest = out.rest;
      if (out.action === 'break') break;
      continue;
    }
    if (lt === 'list') {
      const out = absorbNestedList(lx, tokens, rest, rawAll, textAll);
      rawAll = out.rawAll;
      textAll = out.textAll;
      rest = out.rest;
      continue;
    }
    // Any other token type: keep consuming the next chunk.
  }
  return { type: 'blockquote', raw: rawAll, tokens, text: textAll };
}

// Consume the continuation lines of one list item: lines indented at least
// `indent`, blank lines, and (for a non-empty first line) lines that do not
// start a new block. Returns the item text and the unconsumed rest.
function listItemBody(rest, indent, empty, content, itemText) {
  const nextBullet = O.nextBulletRegex(indent);
  const hrRe = O.hrRegex(indent);
  const fencesBegin = O.fencesBeginRegex(indent);
  const headingBegin = O.headingBeginRegex(indent);
  const htmlBegin = O.htmlBeginRegex(indent);
  const quoteBegin = O.blockquoteBeginRegex(indent);
  let cur = rest;
  let curEmpty = empty;
  let curContent = content;
  let text = itemText;
  while (cur) {
    const line = cur.split('\n', 1)[0];
    const expanded = line.replace(O.leadingSpaceTab, (v) => expandTabs(v));
    if (
      fencesBegin.test(line) || headingBegin.test(line) || htmlBegin.test(line) ||
      quoteBegin.test(line) || nextBullet.test(line) || hrRe.test(line)
    ) break;
    if (expanded.search(O.nonSpaceChar) >= indent || !line.trim()) {
      text += '\n' + expanded.slice(indent);
    } else {
      if (
        curEmpty ||
        curContent.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4 ||
        fencesBegin.test(curContent) || headingBegin.test(curContent) ||
        htmlBegin.test(curContent) || hrRe.test(curContent)
      ) break;
      let add = line;
      if (/^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(`${curContent}\n${line}`)) {
        add = '    ' + expanded.replace(/^ {0,3}/, '');
      }
      text += '\n' + add;
    }
    curEmpty = !line.trim();
    cur = cur.substring(line.length + 1);
    curContent = expanded.slice(indent);
  }
  return { text, rest: cur };
}

// Build one list item: its raw text, task flag, and empty token list.
function listItem(raw, text) {
  return {
    type: 'list_item',
    raw,
    task: !!O.listIsTask.test(text),
    loose: false,
    text,
    tokens: [],
  };
}

// Consume a list item's body lines: returns the item text and the rest.
// A blank item (empty first line followed by a blank line) has no body.
function consumeItemBody(rest, indent, empty, content, itemText, nextLine) {
  if (empty && O.blankLine.test(nextLine)) {
    return { text: itemText, rest: rest.substring(nextLine.length + 1) };
  }
  return listItemBody(rest, indent, empty, content, itemText);
}

function tokList(lx, src) {
  const first = BLOCK.list.exec(src);
  if (first === null) return null;
  let rest = src;
  const startOf = () => src.length - rest.length;
  const marker = first[1].trim();
  const ordered = marker.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +marker.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bullRe = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
  const itemRe = O.listItemRegex(bullRe);
  let sawDoubleBlank = false;
  while (rest) {
    let itemText = '';
    const m = itemRe.exec(rest);
    if (m === null || BLOCK.hr.test(rest)) break;
    const itemStart = startOf();
    rest = rest.substring(m[0].length);
    const firstLine = m[2].split('\n', 1)[0];
    const markerLen = m[1].length;
    const content = firstLine.replace(O.leadingSpaceTab, (v) => expandTabs(v, markerLen));
    const nextLine = rest.split('\n', 1)[0];
    const empty = !content.trim();
    // The item body starts after the marker plus the gap that follows
    // it; a gap wider than 4 columns counts as a single space.
    const rawGap = empty ? 1 : content.search(O.nonSpaceChar);
    const gap = rawGap > 4 ? 1 : rawGap;
    const indent = markerLen + gap;
    if (!empty) itemText = content.slice(gap);
    const body = consumeItemBody(rest, indent, empty, content, itemText, nextLine);
    itemText = body.text;
    rest = body.rest;
    const itemEnd = startOf();
    const itemRaw = src.slice(itemStart, itemEnd);
    if (!list.loose) {
      if (sawDoubleBlank) list.loose = true;
      else if (O.doubleBlankLine.test(itemRaw)) sawDoubleBlank = true;
    }
    list.items.push(listItem(itemRaw, itemText));
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem === undefined) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(0, startOf()).trimEnd();
  // Tokenise each item's text as blocks; a blank line inside an item
  // makes the whole list loose, and a loose list turns bare text tokens
  // into paragraphs.
  for (const item of list.items) {
    lx.top = false;
    item.tokens = blockTokens(lx, item.text, []);
    if (list.loose) continue;
    const hasBlankSpace = item.tokens.some((t) => t.type === 'space' && O.anyLine.test(t.raw));
    if (hasBlankSpace) list.loose = true;
  }
  for (const item of list.items) applyTaskItem(lx, list, item);
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return list;
}

// Handle a task-list item: strip the `[ ]`/`[x]` marker from the text and
// the first token, and insert a checkbox token.
function applyTaskItem(lx, list, item) {
  const firstTok = item.tokens[0];
  if (!item.task) return;
  if (firstTok === undefined || (firstTok.type !== 'text' && firstTok.type !== 'paragraph')) {
    item.task = false;
    return;
  }
  item.text = item.text.replace(O.listReplaceTask, '');
  firstTok.raw = firstTok.raw.replace(O.listReplaceTask, '');
  firstTok.text = firstTok.text.replace(O.listReplaceTask, '');
  for (let i = lx.inlineQueue.length - 1; i >= 0; i--) {
    if (O.listIsTask.test(lx.inlineQueue[i].src)) {
      lx.inlineQueue[i].src = lx.inlineQueue[i].src.replace(O.listReplaceTask, '');
      break;
    }
  }
  const cb = O.listTaskCheckbox.exec(item.raw);
  if (cb === null) return;
  const box = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
  item.checked = box.checked;
  if (!list.loose) {
    item.tokens.unshift(box);
    return;
  }
  const head = item.tokens[0];
  if (head !== undefined && (head.type === 'paragraph' || head.type === 'text') && 'tokens' in head && head.tokens) {
    head.raw = box.raw + head.raw;
    head.text = box.raw + head.text;
    head.tokens.unshift(box);
  } else {
    item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
  }
}

function tokHtml(src) {
  const m = BLOCK.html.exec(src);
  if (m === null) return null;
  const raw = trimBlankTail(m[0]);
  const pre = m[1] === 'pre' || m[1] === 'script' || m[1] === 'style';
  return { type: 'html', block: true, raw, pre, text: raw };
}

function tokDef(src) {
  const m = BLOCK.def.exec(src);
  if (m === null) return null;
  if (!O.startAngleBracket.test(m[2]) && parenScan(m[2], '()', '') !== -1) return null;
  const tag = normLabel(m[1]);
  const href = m[2] ? m[2].replace(O.hrefBrackets, '$1').replace(INLINE.anyPunct, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunct, '$1') : m[3];
  return { type: 'def', tag, raw: stripTail(m[0], '\n'), href, title };
}

// Map one delimiter cell (`---`, `:---`, `---:`, `:---:`) to its alignment.
function tableAlign(cell) {
  if (O.tableAlignRight.test(cell)) return 'right';
  if (O.tableAlignCenter.test(cell)) return 'center';
  if (O.tableAlignLeft.test(cell)) return 'left';
  return null;
}

// Build one table cell (header or body): its text, queued inline tokens,
// and the column alignment.
function tableCell(lx, text, isHeader, align) {
  return {
    text,
    tokens: queueInline(lx, text, []),
    header: isHeader,
    align,
  };
}

function tokTable(lx, src) {
  const m = BLOCK.table.exec(src);
  if (m === null || !O.tableDelimiter.test(m[2])) return null;
  const headerCells = splitCells(m[1]);
  const alignsRaw = m[2].replace(O.tableAlignChars, '').split('|');
  const bodyLines = m[3]?.trim() ? m[3].replace(O.tableRowBlankLine, '').split('\n') : [];
  if (headerCells.length !== alignsRaw.length) return null;
  const table = { type: 'table', raw: stripTail(m[0], '\n'), header: [], align: [], rows: [] };
  for (const a of alignsRaw) table.align.push(tableAlign(a));
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push(tableCell(lx, headerCells[i], true, table.align[i]));
  }
  for (const line of bodyLines) {
    const cells = splitCells(line, table.header.length);
    table.rows.push(cells.map((cell, j) => tableCell(lx, cell, false, table.align[j])));
  }
  return table;
}

function tokLheading(lx, src) {
  const m = BLOCK.lheading.exec(src);
  if (m === null) return null;
  const text = m[1].trim();
  const depth = m[2].charAt(0) === '=' ? 1 : 2;
  return {
    type: 'heading',
    raw: stripTail(m[0], '\n'),
    depth,
    text,
    tokens: queueInline(lx, text, []),
  };
}

function tokParagraph(lx, src) {
  const m = BLOCK.paragraph.exec(src);
  if (m === null) return null;
  const raw = m[0];
  const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  return { type: 'paragraph', raw, text, tokens: queueInline(lx, text, []) };
}

function tokText(lx, src) {
  const m = BLOCK.text.exec(src);
  if (m === null) return null;
  return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(lx, m[0], []) };
}

// ---------------------------------------------------------------- block pass

// Append a newline to the previous token when a single-newline space is
// consumed; otherwise push the space token.
function mergeSpace(tokens, tok) {
  const last = tokens[tokens.length - 1];
  if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
  else tokens.push(tok);
}

// Skip a run of the given character code from `i`; returns the index just
// past the run.
function skipRun(line, i, c) {
  let j = i;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  return j;
}

// Skip spaces and tabs from `i`; returns the index just past them.
function skipSpaces(line, i) {
  let k = i;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  return k;
}

// Classify one line for the setext scan: 1 = it is a setext underline,
// -1 = scanning stops here (blank line or another block), 0 = keep going.
function setextLine(line) {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  const c = line.charCodeAt(i);
  // A run of `=` or `-` covering the line (after optional spaces) is a
  // setext underline.
  if (c === 61 || c === 45) {
    const runEnd = skipRun(line, i, c);
    const tailEnd = skipSpaces(line, runEnd);
    if (tailEnd === line.length && runEnd > i) return 1;
  }
  if (line.trim() === '') return -1;
  if (c === 35 || c === 62 || c === 60) return -1;
  const fence = (c === 96 || c === 126) &&
    line.charCodeAt(i + 1) === c && line.charCodeAt(i + 2) === c;
  if (fence) return -1;
  return 0;
}

// Merge a token into the preceding paragraph/text token, extending its raw
// and text and pointing its queued inline source at the merged text.
// Returns false when there is no preceding paragraph or text token.
function mergeIntoPrev(lx, tokens, tok, textPart) {
  const last = tokens[tokens.length - 1];
  if (last === undefined || (last.type !== 'paragraph' && last.type !== 'text')) return false;
  last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
  last.text += '\n' + textPart;
  lx.inlineQueue[lx.inlineQueue.length - 1].src = last.text;
  return true;
}

// Merge a token into the preceding token of the given type, extending its
// raw and text and dropping the merged token's queued inline source.
// Merge a token into the preceding token of the same type (a paragraph or
// text continuation): join the raw with a newline when the previous raw
// does not already end in one, and re-point the queued inline source at
// the merged text. Returns false when the preceding token is of another
// type (or there is none).
function mergeIntoType(lx, tokens, tok, type) {
  const last = tokens[tokens.length - 1];
  if (last === undefined || last.type !== type) return false;
  const sep = last.raw.endsWith('\n') ? '' : '\n';
  last.raw += sep + tok.raw;
  last.text += '\n' + tok.text;
  lx.inlineQueue.pop();
  lx.inlineQueue[lx.inlineQueue.length - 1].src = last.text;
  return true;
}

function blockTokens(lx, src, tokens = [], mergePara = false) {
  let shortest = Infinity;
  // Index just past up to 3 leading spaces (most block openers allow
  // at most 3). A guard that says "no" means the matching regex cannot
  // match; a guard that says "yes" just runs the regex.
  const at3 = () => {
    let i = 0;
    while (i < 3 && src.charCodeAt(i) === 32) i++;
    return i;
  };
  const hasTableShape = () => {
    if (!src.includes('|')) return false;
    const lines = src.split('\n', 2);
    if (lines.length < 2) return false;
    return lines[1].includes('|') && lines[1].includes('-');
  };
  const hasSetext = () => {
    // A setext underline must sit on a line of the upcoming paragraph
    // (the text cannot cross a blank line), so scan lines only until
    // the first blank line or a line that clearly starts another block.
    let pos = src.indexOf('\n');
    while (pos !== -1) {
      const next = src.indexOf('\n', pos + 1);
      const line = src.slice(pos + 1, next === -1 ? src.length : next);
      const verdict = setextLine(line);
      if (verdict !== 0) return verdict === 1;
      pos = next;
    }
    return false;
  };
  for (; src;) {
    if (src.length < shortest) shortest = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let tok;
    const c0 = src.charCodeAt(0);
    // Blank lines and leading whitespace belong to a space token.
    if ((c0 === 32 || c0 === 9 || c0 === 10) && (tok = tokSpace(src))) {
      src = src.substring(tok.raw.length);
      mergeSpace(tokens, tok);
      continue;
    }
    const i3 = at3();
    // An indented code block: four spaces, or a tab after up to 3 spaces.
    const indentedCode = src.startsWith('    ') || src.charCodeAt(i3) === 9;
    if (indentedCode && (tok = tokCode(src))) {
      src = src.substring(tok.raw.length);
      if (!mergeIntoPrev(lx, tokens, tok, tok.text)) tokens.push(tok);
      continue;
    }
    const ch3 = src.charCodeAt(i3);
    // Dispatch: try each block tokenizer in turn; the first non-null
    // token wins. Order matters (hr before list; def/table/setext only
    // after the single-char dispatchers), and a tokenizer returning null
    // falls through to the next candidate.
    let tokKind = '';
    const tryTok = (kind, fn) => {
      if (tok) return;
      const t = fn();
      if (t) {
        tok = t;
        tokKind = kind;
      }
    };
    const fenceStart =
      (ch3 === 96 || ch3 === 126) &&
      src.charCodeAt(i3 + 1) === ch3 &&
      src.charCodeAt(i3 + 2) === ch3;
    if (fenceStart) tryTok('fences', () => tokFences(src));
    tryTok('heading', () => (ch3 === 35 ? tokHeading(lx, src) : null));
    tryTok('hr', () => (ch3 === 45 || ch3 === 95 || ch3 === 42 ? tokHr(src) : null));
    tryTok('blockquote', () => (ch3 === 62 ? tokBlockquote(lx, src) : null));
    tryTok('list', () =>
      ch3 === 42 || ch3 === 43 || ch3 === 45 || (ch3 >= 48 && ch3 <= 57)
        ? tokList(lx, src)
        : null,
    );
    tryTok('html', () => (ch3 === 60 ? tokHtml(src) : null));
    tryTok('def', () => (ch3 === 91 ? tokDef(src) : null));
    tryTok('table', () => (hasTableShape() ? tokTable(lx, src) : null));
    tryTok('lheading', () => (hasSetext() ? tokLheading(lx, src) : null));
    tryTok('paragraph', () => (lx.top ? tokParagraph(lx, src) : null));
    tryTok('text', () => tokText(lx, src));
    if (tok) {
      src = src.substring(tok.raw.length);
      if (tokKind === 'def') {
        if (!mergeIntoPrev(lx, tokens, tok, tok.raw)) {
          if (!lx.links[tok.tag]) {
            lx.links[tok.tag] = { href: tok.href, title: tok.title };
            lx.linkCount++;
          }
          tokens.push(tok);
        }
      } else if (tokKind === 'paragraph') {
        if (mergePara && mergeIntoType(lx, tokens, tok, 'paragraph')) {
          // Merged into the preceding paragraph (blockquote continuation).
        } else {
          tokens.push(tok);
        }
        mergePara = false;
      } else if (tokKind === 'text') {
        if (!mergeIntoType(lx, tokens, tok, 'text')) tokens.push(tok);
      } else {
        tokens.push(tok);
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  lx.top = true;
  return tokens;
}

// ---------------------------------------------------------------- inline core

// Scan a string for the last positions where an emphasis/delimiter run
// could close: a run whose preceding character is not whitespace.
// Returns the masked source plus the last closer index per delimiter.
function scanClosers(s) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  const n = s.length;
  // Whitespace that disqualifies a run from closing (space, tab, newline,
  // carriage return, form feed).
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  for (let i = 0; i < n;) {
    const ch = s[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') { i++; continue; }
    // Measure the run, then record it when the character before it is
    // not whitespace (a run at the start counts: its "previous" is a
    // newline).
    let j = i + 1;
    while (j < n && s[j] === ch) j++;
    const prev = i === 0 ? '\n' : s[i - 1];
    if (!isSpace(prev)) {
      if (ch === '~') del = i;
      else em[ch] = i;
    }
    i = j;
  }
  return { maskedSrc: s, em, del };
}

// Mask a string for emphasis scanning: replace the insides of links, code
// spans and raw HTML with filler, keeping the length identical so indices
// still line up with the original.
function maskForEmphasis(lx, src) {
  const hasBracket = src.includes('[');
  const hasTick = src.includes('`');
  const hasLt = src.includes('<');
  const hasBackslash = src.includes('\\');
  if (!hasBracket && !hasTick && !hasLt && !hasBackslash) return src;
  let t = src;
  if (lx.linkCount > 0 && hasBracket && src.includes(']')) {
    t = t.replace(INLINE.reflinkSearch, (r) => maskReflink(lx, r));
  }
  if (hasTick || hasBackslash) {
    t = t.replace(INLINE.anyPunctOutsideCode, (m, ticks, punct) => {
      if (punct) return '+'.repeat(m.length);
      if (ticks) return ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
      return m;
    });
  }
  if (hasTick || hasLt || (hasBracket && src.includes(']('))) {
    t = t.replace(INLINE.blockSkip, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  }
  return t;
}

// Mask one reference-style link match for emphasis scanning: a link whose
// label resolves is replaced by filler of the same length, so the emphasis
// scanner cannot see a closer inside it.
function maskReflink(lx, r) {
  const o = r.lastIndexOf('[');
  const label = r.slice(o + 1, -1);
  if (!Object.hasOwn(lx.links, normLabel(label))) return r;
  // A link whose text itself contains a link: mask the inner links first,
  // then fill the label with 'a's.
  if (o > 1 && r.charAt(0) !== '!') {
    const inner = r.slice(1, o - 1);
    if (linkInText(lx, inner)) {
      const maskedInner = inner.replace(INLINE.reflinkSearch, (x) => maskReflink(lx, x));
      return '[' + maskedInner + '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

function linkInText(lx, s) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(INLINE.reflinkSearch)) {
    const r = m[0];
    const o = r.lastIndexOf('[');
    const isImage = r.charAt(0) === '!';
    const labelKnown = Object.hasOwn(lx.links, normLabel(r.slice(o + 1, -1)));
    const nested = o > 1 && linkInText(lx, r.slice(1, o - 1));
    if (!isImage && labelKnown && !nested) return true;
  }
  return false;
}

// Read one field of the cached scanClosers result for this masked string,
// computing it once per tokeniser invocation.
function lastCloserField(lx, masked, field) {
  const top = lx.emStack[lx.emStack.length - 1];
  if (top !== undefined && top.maskedSrc === masked) {
    if (top[field] === null) top[field] = scanClosers(masked)[field];
    return top[field];
  }
  return scanClosers(masked)[field];
}

// Last possible closer index for `ch` ('*' or '_') in the masked string,
// consulting the per-tokeniser cache stack first.
function lastEmCloser(lx, masked, ch) {
  return lastCloserField(lx, masked, 'em')[ch];
}

function lastDelCloser(lx, masked) {
  return lastCloserField(lx, masked, 'del');
}

// Mask the emphasis/delimiter runs in a string when it contains any, so
// the inline loop can find closers without re-scanning.
function maskedForEmphasis(lx, src) {
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  return needsMask ? maskForEmphasis(lx, src) : src;
}

function inlineTokens(lx, src, tokens = []) {
  const savedParen = lx.linkParenPossible;
  lx.linkParenPossible = savedParen && src.includes(')');
  try {
    const masked = maskedForEmphasis(lx, src);
    lx.emStack.push({ maskedSrc: masked, em: null, del: null });
    try {
      return inlineLoop(lx, src, masked, tokens);
    } finally {
      lx.emStack.pop();
    }
  } finally {
    lx.linkParenPossible = savedParen;
  }
}

// Cheap superset test: could an extended autolink (www., a scheme:// URL,
// mailto:/xmpp:, or a bare email address) start at this position? The
// full url regex decides; this only skips it when it cannot match.
const URL_START_RE = new RegExp(String.raw`^www\.|^https?:\/\/|^ftp:\/\/|^mailto:|^xmpp:`, 'i');
// Characters that end a bare-URL candidate (whitespace is handled
// separately; these are < [ ] ` * ~ \ ! ( )).
const URL_STOP = new Set([60, 91, 93, 96, 42, 126, 92, 33, 40, 41]);

function isUrlStart(src) {
  const c = src.charCodeAt(0);
  const isAlnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  if (!isAlnum && c !== 46 && c !== 95 && c !== 43 && c !== 45) return false;
  if (URL_START_RE.test(src)) return true;
  for (let i = 1; i < src.length; i++) {
    const ch = src.charCodeAt(i);
    if (ch === 64) return true; // '@': a bare email may start here
    if (ch <= 32 || URL_STOP.has(ch)) return false;
    if (i >= 80) return true; // undecided: let the regex decide
  }
  return false;
}

// First-character dispatch for the inline loop: each entry tries the
// tokenisers that can match at that character, in marked's order, and
// returns the token or null. The '!' case is not in the table: only a
// '![' starts a link or image, and a bare '!' falls through to the URL
// check below, exactly as the if/else chain this replaces did.
const INLINE_DISPATCH = {
  92: (lx, src) => tokEscape(src) ?? tokBr(src),
  60: (lx, src) => tokTag(lx, src) ?? tokAutolink(src),
  91: (lx, src) => tokLink(lx, src) ?? tokReflink(lx, src),
  42: (lx, src, masked, prev) => tokEmStrong(lx, src, masked, prev),
  95: (lx, src, masked, prev) => tokEmStrong(lx, src, masked, prev),
  96: (lx, src) => tokCodespan(src),
  126: (lx, src, masked, prev) => tokDel(lx, src, masked, prev),
  32: (lx, src) => tokBr(src),
};

// Append an inline token, merging a text token into the preceding text
// token when there is one.
function pushInline(out, tok) {
  if (tok.type === 'text') {
    const last = out[out.length - 1];
    if (last !== undefined && last.type === 'text') {
      last.raw += tok.raw;
      last.text += tok.text;
      return;
    }
  }
  out.push(tok);
}

function inlineLoop(lx, src, masked, out) {
  let justText = false;
  let prev = '';
  let shortest = Infinity;
  for (; src;) {
    if (src.length < shortest) shortest = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!justText) prev = '';
    justText = false;
    // Dispatch on the first character: only the tokenisers that can match
    // at this position are attempted, in marked's order. The URL check
    // runs only when no branch matched at all.
    const c0 = src.charCodeAt(0);
    const dispatch = INLINE_DISPATCH[c0];
    let matched = dispatch !== undefined;
    let tok = matched ? dispatch(lx, src, masked, prev) : null;
    if (!matched && c0 === 33 && src.charCodeAt(1) === 91) {
      matched = true;
      tok = tokLink(lx, src) ?? tokReflink(lx, src);
    }
    if (!matched && !lx.inLink && isUrlStart(src)) tok = tokUrl(src);
    // tokLink/tokReflink can return undefined (makeLink drops a nested
    // link), so the check is a truthiness test, not a null test.
    if (tok) {
      src = src.substring(tok.raw.length);
      pushInline(out, tok);
      continue;
    }
    tok = tokInlineText(lx, src);
    if (tok) {
      src = src.substring(tok.raw.length);
      if (tok.raw.slice(-1) !== '_') prev = tok.raw.slice(-1);
      justText = true;
      pushInline(out, tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return out;
}

// ---------------------------------------------------------------- inline tokenisers

// A backslash escape: `\` followed by an ASCII punctuation character.
// When the next character is not escapable punctuation this returns null
// and the caller tries a hard break instead.
function tokEscape(src) {
  const m = INLINE.escape.exec(src);
  if (m === null) return null;
  return { type: 'escape', raw: m[0], text: m[1] };
}

function tokTag(lx, src) {
  const m = INLINE.tag.exec(src);
  if (m === null) return null;
  const tag = m[0];
  // Track whether inline content is inside a link or a raw block (pre,
  // code, kbd, script): the lexer consults both flags while tokenising.
  if (O.startATag.test(tag)) lx.inLink = true;
  if (O.endATag.test(tag)) lx.inLink = false;
  if (O.startPreScriptTag.test(tag)) lx.inRawBlock = true;
  if (O.endPreScriptTag.test(tag)) lx.inRawBlock = false;
  return { type: 'html', raw: tag, inLink: lx.inLink, inRawBlock: lx.inRawBlock, block: false, text: tag };
}

// Does the link text contain a raw HTML tag that runs past its end?
// (Such a link is not a link at all.)
function linkTextHasRawTag(fullSrc, linkText, offset) {
  if (!linkText.includes('<')) return false;
  let i = 0;
  while (i < linkText.length) {
    const ch = linkText[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      const m = INLINE.code.exec(linkText.slice(i));
      if (m !== null) { i += m[0].length; continue; }
    }
    if (ch !== '<') { i++; continue; }
    const rest = fullSrc.slice(offset + i);
    const m = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (m === null) { i++; continue; }
    if (m[0].length > linkText.length - i) return true;
    i += m[0].length;
  }
  return false;
}

// Build a link or image token, tokenising its text. Returns undefined when
// the text itself already emitted a link (nested links are dropped).
function makeLink(lx, match, ref, raw) {
  const text = match[1].replace(O.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  // Tokenise the link text with the link state set: a link inside the
  // text marks it, and the token is dropped unless it is an image.
  const saved = { inLink: lx.inLink, linkEmitted: lx.linkEmitted, inRawBlock: lx.inRawBlock };
  lx.inLink = true;
  lx.linkEmitted = false;
  const tokens = inlineTokens(lx, text);
  const emittedInside = lx.linkEmitted;
  lx.inLink = saved.inLink;
  lx.linkEmitted = saved.linkEmitted;
  if (!isImage) {
    if (emittedInside) {
      lx.inRawBlock = saved.inRawBlock;
      return undefined;
    }
    lx.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href: ref.href, title: ref.title || null, text, tokens };
}

function tokLink(lx, src) {
  if (lx.linkParenPossible === false) return null;
  const m = INLINE.link.exec(src);
  if (m === null) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkTextHasRawTag(src, m[1], bang)) return null;
  const dt = linkDest(m);
  if (dt === null) return null;
  return makeLink(lx, m, { href: dt[0], title: dt[1] }, m[0]);
}

// Validate an angle-bracket destination: it must close, and the closing
// bracket must not be escaped by an odd run of backslashes.
function validAngleDest(href) {
  if (!O.endAngleBracket.test(href)) return false;
  const stripped = stripTail(href.slice(0, -1), '\\');
  return (href.length - stripped.length) % 2 !== 0;
}

// Trim a bare destination at the first unbalanced parenthesis, adjusting
// the match in place. Returns false when the parens are malformed.
function trimBareDest(m) {
  const p = parenScan(m[2], '()', '');
  if (p === -2) return false;
  if (p > -1) {
    const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + p;
    m[2] = m[2].substring(0, p);
    m[0] = m[0].substring(0, cut).trim();
    m[3] = '';
  }
  return true;
}

// Validate and clean an inline link's destination and title. The match is
// adjusted in place when a bare destination ends early at a parenthesis.
// Returns [dest, title] or null when the destination is malformed.
function linkDest(m) {
  const href = m[2].trim();
  if (O.startAngleBracket.test(href)) {
    if (!validAngleDest(href)) return null;
  } else if (!trimBareDest(m)) {
    return null;
  }
  const rawStripped = stripTail(m[0].slice(0, -1), '\\');
  if ((m[0].length - rawStripped.length) % 2 === 0) return null;
  let dest = m[2].trim();
  if (O.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
  const title = m[3] ? m[3].slice(1, -1) : '';
  const clean = (s) => s.replace(INLINE.anyPunct, '$1');
  return [dest && clean(dest), title && clean(title)];
}

function tokReflink(lx, src) {
  const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
  if (m === null) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkTextHasRawTag(src, m[1], bang)) return null;
  // A collapsed or shortcut reference: the label is the bracket text
  // unless an explicit label follows it.
  const label = m[2] !== undefined && m[2] !== '' ? m[2] : m[1];
  const ref = lx.links[normLabel(label)];
  if (ref === undefined) {
    // No such reference: only the opening bracket (or '!') is text; the
    // rest is re-scanned from the next character.
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return makeLink(lx, m, ref, m[0]);
}

function tokEmStrong(lx, src, masked, prev) {
  const m = INLINE.emStrongLDelim.exec(src);
  if (m === null || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const delim = m[0][0];
  const wasDelim = prev === delim;
  const offset = masked.length - src.length;
  let left = offset;
  while (left > 0 && masked[left - 1] === delim) left--;
  const beforeRun = [...masked.slice(Math.max(0, left - 2), left)].at(-1) ?? '';
  const beforeIsDelimOrPunct =
    beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
  if (left < offset) prev = beforeRun;
  const prevIsPunct = left < offset ? beforeIsDelimOrPunct : !!INLINE.punctuation.exec(prev);
  if (m[4] && O.unicodeAlphaNumeric.test(prev)) return null;
  const afterPunct = m[1] || m[3] || '';
  if (afterPunct && prev && !prevIsPunct) return null;
  const runLen = [...m[0]].length - 1;
  const total = offset - left + runLen;
  const canOpenStrong = !!beforeRun.trim() && (!!afterPunct || (delim === '*' && !beforeIsDelimOrPunct));
  if (delim !== '*' && delim !== '_') return null;
  const closerRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
  const lastCloser = lastEmCloser(lx, masked, delim);
  const needPos = masked.length - src.length + runLen;
  if (lastCloser < needPos) return null;
  const rest = masked.slice(-src.length + runLen);
  const limit = lastCloser - needPos;
  return emStrongCloser(lx, src, closerRe, rest, limit, runLen, total, canOpenStrong, wasDelim);
}

// Scan for the emphasis/strong closer: walk the right-delimiter matches,
// skipping openers (groups 3/4) and applying the rule of three, until the
// opening run is exhausted. Returns the em/strong token or null.
function emStrongCloser(lx, src, closerRe, rest, limit, runLen, total, canOpenStrong, wasDelim) {
  let openLeft = runLen;
  let skipped = 0;
  for (closerRe.lastIndex = 0; ;) {
    const cm = closerRe.exec(rest);
    if (cm === null || cm.index > limit) break;
    const g = cm[1] || cm[2] || cm[3] || cm[4] || cm[5] || cm[6];
    if (!g) continue;
    const b = [...g].length;
    if (cm[3] || cm[4]) { openLeft += b; continue; }
    if (cm[5] || cm[6] || canOpenStrong) {
      if (wasDelim && (cm[5] || cm[6])) break;
      if (total % 3 && !((total + b) % 3)) { skipped += b; continue; }
    }
    if ((openLeft -= b) > 0) continue;
    const useLen = Math.min(b, b + openLeft + skipped);
    const firstLen = [...cm[0]][0].length;
    const rawLen = runLen + cm.index + firstLen + useLen;
    const raw = src.slice(0, rawLen);
    if (Math.min(runLen, useLen) % 2) {
      const inner = raw.slice(1, -1);
      return { type: 'em', raw, text: inner, tokens: inlineTokens(lx, inner) };
    }
    const inner = raw.slice(2, -2);
    return { type: 'strong', raw, text: inner, tokens: inlineTokens(lx, inner) };
  }
  return null;
}

function tokCodespan(src) {
  const m = INLINE.code.exec(src);
  if (m === null) return null;
  const text = m[2].replace(O.newLineCharGlobal, ' ');
  const stripped = O.nonSpaceChar.test(text) &&
    O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text)
    ? text.substring(1, text.length - 1)
    : text;
  return { type: 'codespan', raw: m[0], text: stripped };
}

function tokBr(src) {
  const m = INLINE.br.exec(src);
  if (m === null) return null;
  return { type: 'br', raw: m[0] };
}

function tokDel(lx, src, masked, prev) {
  const m = INLINE.delLDelim.exec(src);
  if (m === null) return null;
  if (!((m[1] || '') || !prev || INLINE.punctuation.exec(prev))) return null;
  const runLen = [...m[0]].length - 1;
  const lastCloser = lastDelCloser(lx, masked);
  const needPos = masked.length - src.length + runLen;
  if (lastCloser < needPos) return null;
  const rest = masked.slice(-src.length + runLen);
  const limit = lastCloser - needPos;
  return delCloser(lx, src, rest, limit, runLen);
}

// Pick the delimiter run out of a delRDelim match: the first non-empty
// capture group, plus whether it is an opener (groups 3/4).
function delRun(cm) {
  const g = cm[1] || cm[2] || cm[3] || cm[4] || cm[5] || cm[6];
  if (!g) return null;
  return { len: [...g].length, opener: !!(cm[3] || cm[4]) };
}

// Scan for the strikethrough closer: the closing run must be exactly the
// opening run's length; openers (groups 3/4) extend the run instead.
function delCloser(lx, src, rest, limit, runLen) {
  const closerRe = INLINE.delRDelim;
  let openLeft = runLen;
  for (closerRe.lastIndex = 0; ;) {
    const cm = closerRe.exec(rest);
    if (cm === null || cm.index > limit) break;
    const run = delRun(cm);
    if (run === null || run.len !== runLen) continue;
    // An opener extends the run instead of closing it.
    if (run.opener) { openLeft += run.len; continue; }
    if ((openLeft -= run.len) > 0) continue;
    const useLen = Math.min(run.len, run.len + openLeft);
    const firstLen = [...cm[0]][0].length;
    const raw = src.slice(0, runLen + cm.index + firstLen + useLen);
    const inner = raw.slice(runLen, -runLen);
    return { type: 'del', raw, text: inner, tokens: inlineTokens(lx, inner) };
  }
  return null;
}

// Build an autolink token from a matched raw/text/href triple.
function autolinkToken(raw, text, href) {
  return {
    type: 'link',
    raw,
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

function tokAutolink(src) {
  const m = INLINE.autolink.exec(src);
  if (m === null) return null;
  const text = m[1];
  const href = m[2] === '@' ? 'mailto:' + text : text;
  return autolinkToken(m[0], text, href);
}

function tokUrl(src) {
  const m = INLINE.url.exec(src);
  if (m === null) return null;
  // An email address matched as a bare URL becomes a mailto: link.
  if (m[2] === '@') {
    return autolinkToken(m[0], m[0], 'mailto:' + m[0]);
  }
  // Backpedal: strip trailing punctuation the URL regex over-matched,
  // until the backpedal regex stops shrinking the match.
  let text = m[0];
  for (;;) {
    const shorter = INLINE.backpedal.exec(text)?.[0] ?? '';
    if (shorter === text) break;
    text = shorter;
  }
  const href = m[1] === 'www.' ? 'http://' + text : text;
  return autolinkToken(text, text, href);
}

// Inline text, without the big text regex: find where the plain-text run
// must stop, using the same stop rules marked's text regex encodes:
//   - a hard stop before \ < ! [ ` * ~ _ (the run may start on one when
//     the tokeniser for it failed, so the search starts at index 1)
//   - two or more spaces followed by a newline (a hard break), when the
//     character before the spaces is not a space
//   - www. (only after a space, tab, *, _, ~ or (), or a scheme://,
//     mailto: or xmpp: start, and a bare email address (a run of email
//     characters followed by @) — each only from index 1 on, since the
//     dispatcher already tried the URL tokeniser at index 0.
// The characters that may appear in a bare email address's local part,
// as one string: letters, digits and the punctuation marked allows.
const EMAIL_PUNCT = ".!#$%&'*+-/=?^_`{|}~-";

function isEmailChar(code) {
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  return EMAIL_PUNCT.indexOf(String.fromCharCode(code)) !== -1;
}

// The start of the email local part ending at the '@' in src[at], or -1
// when no email character precedes it.
function emailLocalStart(src, at) {
  let s = at;
  while (s > 0 && isEmailChar(src.charCodeAt(s - 1))) s--;
  return s < at ? s : -1;
}

// The characters that end a plain-text run (each one could start markup).
const TEXT_STOP_CHARS = '\\`<[!*_~';

// Where does the plain-text run starting at src[0] end? The run stops
// before any character that could start markup, before a hard break, and
// before a URL or email address that the dispatcher would tokenise instead.
// The rules are the ones marked's text regex encodes. Each rule is found
// with the string's own searches (indexOf), so the work stays in the
// engine's fast paths and the answer is the smallest index among them:
//
//   - a hard stop before \ < ! [ ` * ~ _ (the run may start on one when
//     the tokeniser for it failed, so the search starts at index 1; a
//     leading run of backticks or tildes is consumed as the first unit)
//   - two or more spaces followed by a newline (a hard break), when the
//     character before the spaces is not a space
//   - www. (only after a space, tab, *, _, ~ or (), or a scheme://,
//     mailto: or xmpp: start, and a bare email address (a run of email
//     characters followed by @) — each only from index 1 on, since the
//     dispatcher already tried the URL tokeniser at index 0.
function textRunEnd(src) {
  let end = src.length;
  // The text regex consumes a leading run of backticks or tildes as its
  // first unit, so the hard-stop search starts after such a run (other
  // leading characters are consumed one at a time).
  let from = 1;
  const c0 = src.charCodeAt(0);
  if (c0 === 96 || c0 === 126) {
    while (from < src.length && src.charCodeAt(from) === c0) from++;
  }
  // Hard stop: the first markup character at or after `from`.
  for (let k = 0; k < TEXT_STOP_CHARS.length; k++) {
    const at = src.indexOf(TEXT_STOP_CHARS[k], from);
    if (at !== -1 && at < end) end = at;
  }
  // Hard break: the first newline preceded by two or more spaces. Only
  // the first such newline counts, and only when its run of spaces does
  // not start the string and is not itself preceded by a space.
  let nl = src.indexOf('\n');
  while (nl !== -1) {
    let s = nl - 1;
    while (s >= 0 && src.charCodeAt(s) === 32) s--;
    if (nl - 1 - s >= 2) {
      const start = s + 1;
      if (start >= 1 && start < end && (start === 1 || src.charCodeAt(start - 1) !== 32)) end = start;
      break;
    }
    nl = src.indexOf('\n', nl + 1);
  }
  // URL starts: gather the candidates (www., mailto:, xmpp: by search,
  // and http://, https://, ftp:// in any letter case by looking back
  // from each ':'), then take the leftmost one that qualifies. A www.
  // that is not preceded by a space, tab, *, _, ~ or ( does not count,
  // and the search moves on to the next candidate.
// Collect URL-start candidates (www., mailto:, xmpp:, and scheme://) that
// lie before `end`, sorted leftmost first.
function urlCandidates(src, end) {
  const cands = [];
  for (const word of ['www.', 'mailto:', 'xmpp:']) {
    let at = src.indexOf(word, 1);
    while (at !== -1 && at < end) {
      cands.push({ pos: at, www: word === 'www.' });
      at = src.indexOf(word, at + 1);
    }
  }
  let colon = src.indexOf(':', 1);
  while (colon !== -1) {
    if (src.charCodeAt(colon + 1) === 47 && src.charCodeAt(colon + 2) === 47) {
      const start = schemeStartAt(src, colon);
      if (start !== -1 && start < end) cands.push({ pos: start, www: false });
    }
    colon = src.indexOf(':', colon + 1);
  }
  cands.sort((a, b) => a.pos - b.pos);
  return cands;
}

// A www. candidate only counts when preceded by a space, tab, *, _, ~ or (.
function wwwPreceded(src, pos) {
  const pc = src.charCodeAt(pos - 1);
  return pc === 32 || pc === 9 || pc === 42 || pc === 95 || pc === 126 || pc === 40;
}

// Take the leftmost URL candidate that qualifies; a www. that is not
// preceded by a space, tab, *, _, ~ or ( does not count, and the search
// moves on to the next candidate.
  for (const cand of urlCandidates(src, end)) {
    if (cand.www && !wwwPreceded(src, cand.pos)) continue;
    end = cand.pos;
    break;
  }
  // A bare email address ends the run at the start of its local part.
  let at = src.indexOf('@', 1);
  while (at !== -1 && at < end) {
    const start = emailLocalStart(src, at);
    if (start !== -1) {
      const cut = start >= 1 ? start : at >= 2 ? 1 : -1;
      if (cut !== -1) {
        end = Math.min(end, cut);
        break;
      }
    }
    at = src.indexOf('@', at + 1);
  }
  return end;
}

// The start of an http://, https:// or ftp:// URL whose colon sits at
// src[colon] (with '//' after it), in any letter case — or -1 when the
// characters before the colon are not one of those schemes. The start
// must be at or after index 1, since the dispatcher already tried the
// URL tokeniser at index 0.
function schemeStartAt(src, colon) {
  const low = (c) => c | 32;
  if (colon >= 6) {
    if (
      low(src.charCodeAt(colon - 5)) === 104 && low(src.charCodeAt(colon - 4)) === 116 &&
      low(src.charCodeAt(colon - 3)) === 116 && low(src.charCodeAt(colon - 2)) === 112 &&
      low(src.charCodeAt(colon - 1)) === 115
    ) return colon - 5;
  }
  if (colon >= 5) {
    if (
      low(src.charCodeAt(colon - 4)) === 104 && low(src.charCodeAt(colon - 3)) === 116 &&
      low(src.charCodeAt(colon - 2)) === 116 && low(src.charCodeAt(colon - 1)) === 112
    ) return colon - 4;
  }
  if (colon >= 4) {
    if (
      low(src.charCodeAt(colon - 3)) === 102 && low(src.charCodeAt(colon - 2)) === 116 &&
      low(src.charCodeAt(colon - 1)) === 112
    ) return colon - 3;
  }
  return -1;
}

function tokInlineText(lx, src) {
  const raw = src.slice(0, textRunEnd(src));
  if (lx.inRawBlock) return { type: 'text', raw, text: raw, escaped: true };
  return { type: 'text', raw, text: decodeNumericRefs(raw), escaped: false };
}

// ---------------------------------------------------------------- renderer

// Render one text-ish token: in plain mode the raw text comes back; a
// token carrying its own tokens renders those; an escaped token (raw HTML
// content) is already literal; anything else is HTML-escaped.
function renderText(tok, plain) {
  if (plain) return tok.text;
  if (tok.tokens) return renderInline(tok.tokens, false);
  if (tok.escaped) return tok.text;
  return escHtml(tok.text);
}

// Inline token renderers, one per token type. renderInline walks the list
// and joins what they return; an unknown type is an error, as before.
const INLINE_RENDER = {
  escape(tok, plain) {
    return renderText(tok, plain);
  },
  html(tok) {
    return tok.text;
  },
  link(tok, plain) {
    if (plain) return tok.tokens ? renderInline(tok.tokens, true) : tok.text;
    const inner = tok.autolink ? escHtml(tok.text, true) : renderInline(tok.tokens, false);
    const href = encodeHref(tok.href);
    if (href === null) return inner;
    let tag = '<a href="' + escHtml(href, tok.autolink) + '"';
    if (tok.title) tag += ' title="' + escHtml(tok.title) + '"';
    return tag + '>' + inner + '</a>';
  },
  image(tok, plain) {
    if (plain) return tok.tokens ? renderInline(tok.tokens, true) : tok.text;
    const alt = tok.tokens ? renderInline(tok.tokens, true) : tok.text;
    const href = encodeHref(tok.href);
    if (href === null) return escHtml(alt);
    let tag = '<img src="' + escHtml(href) + '" alt="' + escHtml(alt) + '"';
    if (tok.title) tag += ' title="' + escHtml(tok.title) + '"';
    return tag + '>';
  },
  checkbox(tok, plain) {
    if (plain) return tok.raw;
    return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
  },
  strong(tok, plain) {
    return plain
      ? tok.tokens ? renderInline(tok.tokens, true) : tok.text
      : '<strong>' + renderInline(tok.tokens, false) + '</strong>';
  },
  em(tok, plain) {
    return plain
      ? tok.tokens ? renderInline(tok.tokens, true) : tok.text
      : '<em>' + renderInline(tok.tokens, false) + '</em>';
  },
  codespan(tok, plain) {
    return plain ? tok.text : '<code>' + escHtml(tok.text, true) + '</code>';
  },
  br(tok, plain) {
    return plain ? '' : '<br>';
  },
  del(tok, plain) {
    return plain
      ? tok.tokens ? renderInline(tok.tokens, true) : tok.text
      : '<del>' + renderInline(tok.tokens, false) + '</del>';
  },
  text(tok, plain) {
    return renderText(tok, plain);
  },
};

function renderInline(tokens, plain) {
  // Fast path: a list of only text tokens needs no dispatch.
  let onlyText = true;
  for (const tok of tokens) {
    if (tok.type !== 'text') { onlyText = false; break; }
  }
  if (onlyText) {
    let out = '';
    for (const tok of tokens) out += renderText(tok, plain);
    return out;
  }
  let out = '';
  for (const tok of tokens) {
    const render = INLINE_RENDER[tok.type];
    if (render === undefined) throw new Error('Token with "' + tok.type + '" type was not found.');
    out += render(tok, plain);
  }
  return out;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>';
  return open + renderInline(cell.tokens, false) + '</' + tag + '>\n';
}

function renderListItem(item) {
  return '<li>' + renderTokens(item.tokens) + '</li>\n';
}

// Block token renderers, one per token type, mirroring the inline table
// above. renderTokens walks the list and joins what they return.
const BLOCK_RENDER = {
  space() {
    return '';
  },
  hr() {
    return '<hr>\n';
  },
  heading(tok) {
    return '<h' + tok.depth + '>' + renderInline(tok.tokens, false) + '</h' + tok.depth + '>\n';
  },
  code(tok) {
    const lang = (tok.lang || '').match(O.notSpaceStart)?.[0];
    const text = tok.text ? tok.text.replace(O.endingNewline, '') + '\n' : '';
    const body = escHtml(text, true);
    if (lang) return '<pre><code class="language-' + escHtml(lang) + '">' + body + '</code></pre>\n';
    return '<pre><code>' + body + '</code></pre>\n';
  },
  table(tok) {
    let headCells = '';
    for (const cell of tok.header) headCells += renderTableCell(cell);
    const head = '<tr>\n' + headCells + '</tr>\n';
    let bodyRows = '';
    for (const row of tok.rows) {
      let cells = '';
      for (const cell of row) cells += renderTableCell(cell);
      bodyRows += '<tr>\n' + cells + '</tr>\n';
    }
    if (bodyRows) bodyRows = '<tbody>' + bodyRows + '</tbody>';
    return '<table>\n<thead>\n' + head + '</thead>\n' + bodyRows + '</table>\n';
  },
  blockquote(tok) {
    return '<blockquote>\n' + renderTokens(tok.tokens) + '</blockquote>\n';
  },
  list(tok) {
    let items = '';
    for (const item of tok.items) items += renderListItem(item);
    const tag = tok.ordered ? 'ol' : 'ul';
    const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
    return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
  },
  checkbox(tok) {
    return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
  },
  html(tok) {
    return tok.text;
  },
  def() {
    return '';
  },
  paragraph(tok) {
    return '<p>' + renderInline(tok.tokens, false) + '</p>\n';
  },
  text(tok) {
    return renderText(tok, false);
  },
};

// Render a list of block tokens to HTML, dispatching on each token type.
function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    const render = BLOCK_RENDER[tok.type];
    if (render === undefined) {
      throw new Error('Token with "' + tok.type + '" type was not found.');
    }
    out += render(tok);
  }
  return out;
}

// ---------------------------------------------------------------- entry point

// Parse Markdown to HTML, byte-identical to marked 18.1.3 (default
// options, GFM on). Two phases: the block lexer tokenizes the source and
// queues inline work; the inline pass then fills each token's children.
export function parse(markdown) {
  const lx = newLexer();
  const src = markdown.replace(O.carriageReturn, '\n');
  const tokens = blockTokens(lx, src, []);
  const queue = lx.inlineQueue;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    lx.inRawBlock = false;
    inlineTokens(lx, item.src, item.tokens);
  }
  lx.inlineQueue = [];
  return renderTokens(tokens);
}
