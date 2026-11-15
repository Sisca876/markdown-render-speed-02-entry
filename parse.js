// faster-marked-entry: a dependency-free ES module whose parse(markdown)
// returns exactly the HTML marked 18.1.3 renders with its default options
// (GFM on, breaks off, pedantic off, async off), for less CPU.
//
// Written from scratch for the make.fun "Make Markdown rendering faster"
// bounty. The parsing algorithm follows the same two-phase shape as
// marked's (block lexer, then an inline tokeniser with delimiter-run
// emphasis handling), reimplemented here in a leaner form: no class or
// options machinery, direct string building, and bulk plain-text fast
// paths. Credit to the marked project (MIT) for the reference behaviour
// this drop-in matches byte for byte.

// ---------------------------------------------------------------- helpers

const CARET = /(^|[^\[])\^/g;

// Small builder for regexes composed from parts, like marked's edit().
function rx(src, flags = '') {
  let s = typeof src === 'string' ? src : src.source;
  const api = {
    replace(name, rep) {
      const r = typeof rep === 'string' ? rep : rep.source;
      s = s.replace(name, r.replace(CARET, '$1'));
      return api;
    },
    get() {
      return new RegExp(s, flags);
    },
  };
  return api;
}

// Character classes for the scanners below, written out instead of
// leaning on regexes: the hot paths run these per character.
function isHexCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
function hexValue(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  return c - 87;
}
function isWordCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
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

const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;
// Split a table row into cells, honouring escaped pipes.
function splitCells(row, count) {
  const t = row.replace(FIND_PIPE, (m, off, str) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(SPLIT_PIPE);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(SLASH_PIPE, '|');
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

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Cache a factory's regexes by argument (the indent factories are only
// ever called with a handful of values, so this stays tiny).
function memoRegex(fn) {
  const cache = new Map();
  return (key) => {
    let r = cache.get(key);
    if (!r) {
      r = fn(key);
      cache.set(key, r);
    }
    return r;
  };
}

const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: memoRegex((bull) => new RegExp(`^( {0,3}${bull})((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  // marked's D() memoiser clamps the indent argument to [0, 3] of (t - 1).
  nextBulletRegex: memoRegex((indent) => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: memoRegex((indent) => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: memoRegex((indent) => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: memoRegex((indent) => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: memoRegex((indent) => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: memoRegex((indent) => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}>`)),
};

const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR_SRC = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const HTML_OPEN_SRC = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const FENCES_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const BLOCKQUOTE_SRC = ' {0,3}>';

// Block paragraph core: a run of lines that does not start a new block.
const PARA_CORE =
  /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

// Setext heading (lheading) core, with placeholders replaced per ruleset.
const LHEADING_CORE =
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;

// GFM table.
const TABLE_SRC =
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';

// HTML comment.
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// Block HTML (type 1-7), GFM.
const BLOCK_HTML = rx(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  'i',
)
  .replace('comment', HTML_COMMENT)
  .replace('tag', BLOCK_TAGS)
  .replace(
    'attribute',
    / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
  )
  .get();

// Link reference definition label / title pieces.
const LABEL_INNER = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const TITLE_RE = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const DEF_RE = rx(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
)
  .replace('label', LABEL_INNER)
  .replace('title', TITLE_RE)
  .get();

function buildBlockRules() {
  const lheading = rx(LHEADING_CORE)
    .replace(/bull/g, BULLET)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, HEADING_SRC)
    .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/)
    .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
    .get();
  const table = rx(TABLE_SRC)
    .replace('hr', HR_SRC)
    .replace('heading', HEADING_SRC)
    .replace('blockquote', BLOCKQUOTE_SRC)
    .replace('code', /(?: {4}| {0,3}\t)[^\n]/)
    .replace('fences', FENCES_SRC)
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .replace('html', HTML_OPEN_SRC)
    .replace('tag', BLOCK_TAGS)
    .get();
  const paragraph = rx(PARA_CORE)
    .replace('hr', HR_SRC)
    .replace('heading', HEADING_SRC)
    .replace('|lheading', '')
    .replace('table', table)
    .replace('blockquote', BLOCKQUOTE_SRC)
    .replace('fences', FENCES_SRC)
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
    .replace('html', HTML_OPEN_SRC)
    .replace('tag', BLOCK_TAGS)
    .get();
  const blockquote = rx(
    /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
  )
    .replace('paragraph', paragraph)
    .get();
  return {
    newline: /^(?:[ \t]*(?:\n|$))+/,
    code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
    fences:
      /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
    heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
    hr: HR_SRC,
    blockquote,
    list: rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULLET).get(),
    html: BLOCK_HTML,
    def: DEF_RE,
    table,
    lheading,
    paragraph,
    text: /^[^\n]+/,
  };
}

const BLOCK = buildBlockRules();

// ---------------------------------------------------------------- inline regexes

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NOT_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NOT_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  text: null, // built below (needs url pieces)
  autolink: rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
    .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
    .replace(
      'email',
      /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
    )
    .get(),
  tag: rx(
    '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  )
    .replace('comment', rx(HTML_COMMENT).replace('(?:-->|$)', '-->').get())
    .replace(
      'attribute',
      /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
    )
    .get(),
  link: null,
  reflink: null,
  nolink: null,
  emStrongLDelim: rx(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
    .replace(/punct/g, PUNCT_NOT_TILDE)
    .get(),
  emStrongRDelimAst: rx(
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)',
    'gu',
  )
    .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE)
    .replace(/punctSpace/g, PUNCT_SPACE_NOT_TILDE)
    .replace(/punct/g, PUNCT_NOT_TILDE)
    .get(),
  emStrongRDelimUnd: rx(
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)',
    'gu',
  )
    .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE)
    .replace(/punctSpace/g, PUNCT_SPACE_NOT_TILDE)
    .replace(/punct/g, PUNCT_NOT_TILDE)
    .get(),
  delLDelim: rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, PUNCT).get(),
  delRDelim: rx(
    '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)',
    'gu',
  )
    .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
    .replace(/punctSpace/g, PUNCT_SPACE)
    .replace(/punct/g, PUNCT)
    .get(),
  url: null,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  anyPunct: rx(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).get(),
  anyPunctOutsideCode: rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
    .replace(/punct/g, PUNCT)
    .get(),
  blockSkip: rx(/link|precode-code|html/, 'g')
    .replace(
      'link',
      /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
    )
    .replace('precode-', '(?<!`)()')
    .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
    .replace('html', /<(?! )[^<>]*?>/)
    .get(),
  reflinkSearch: null,
  punctuation: rx(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_SPACE).get(),
};

const EMAIL_RE =
  /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const EMAIL_SIMPLE =
  /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_SIMPLE_GRP =
  /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const PROTOCOL_RE = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const MAILTO_RE = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, EMAIL_SIMPLE)
  .get();

const LINK_LABEL = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', /\[(?:\\[\s\S]|[^\[\]\\])*\]/)
  .get();
const REF_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;

INLINE.link = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', LINK_LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .get();
INLINE.reflink = rx(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', LINK_LABEL)
  .replace('ref', REF_LABEL)
  .get();
INLINE.nolink = rx(/^!?\[(ref)\](?:\[\])?/).replace('ref', REF_LABEL).get();
INLINE.url = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', MAILTO_RE)
  .replace('protocol', PROTOCOL_RE)
  .replace('email', EMAIL_SIMPLE_GRP)
  .get();

const REFLINK_SEARCH = (() => {
  const refInner = rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
    .replace('brackets', /\[(?:\\[\s\S]|[^\[\]\\])*\]/)
    .get();
  const reflinkPat = rx(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', refInner)
    .replace('ref', /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/)
    .get();
  const nolinkPat = rx(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/)
    .get();
  return rx('reflink|nolink(?!\\()', 'g')
    .replace('reflink', reflinkPat)
    .replace('nolink', nolinkPat)
    .get();
})();
INLINE.reflinkSearch = REFLINK_SEARCH;

// Inline text: consumes a run of plain text, stopping before markup.
INLINE.text = rx(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
)
  .replace('protocol', PROTOCOL_RE)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .get();

// ---------------------------------------------------------------- block lexer

// Per-parse lexer state. Fresh for every parse() call: nothing is kept
// from one case to the next.
function newLexer() {
  return {
    tokens: [],
    links: Object.create(null),
    linkCount: 0,
    inlineQueue: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    emStack: [],
  };
}

// Queue inline tokenisation of `src` into `tokens` (done after the block
// pass, like marked, so link definitions anywhere in the document apply).
function queueInline(lx, src, tokens) {
  lx.inlineQueue.push({ src, tokens });
  return tokens;
}

function tokSpace(src) {
  const m = BLOCK.newline.exec(src);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  return null;
}

function tokCode(src) {
  const m = BLOCK.code.exec(src);
  if (m) {
    const raw = trimBlankTail(m[0]);
    const text = raw.replace(O.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }
  return null;
}

function tokFences(src) {
  const m = BLOCK.fences.exec(src);
  if (m) {
    const raw = m[0];
    let text = m[3] || '';
    const indentMatch = raw.match(O.indentCodeCompensation);
    if (indentMatch !== null) {
      const ind = indentMatch[1];
      text = text
        .split('\n')
        .map((line) => {
          const sp = line.match(O.beginningSpace);
          if (sp === null) return line;
          return line.slice(Math.min(sp[0].length, ind.length));
        })
        .join('\n');
    }
    return {
      type: 'code',
      raw,
      lang: m[2] ? m[2].trim().replace(INLINE.anyPunct, '$1') : m[2],
      text,
    };
  }
  return null;
}

function tokHeading(lx, src) {
  const m = BLOCK.heading.exec(src);
  if (m) {
    let text = m[2].trim();
    if (O.endingHash.test(text)) {
      const stripped = stripTail(text, '#');
      if (!stripped || O.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return {
      type: 'heading',
      raw: stripTail(m[0], '\n'),
      depth: m[1].length,
      text,
      tokens: queueInline(lx, text, []),
    };
  }
  return null;
}

function tokHr(src) {
  const m = BLOCK.hr.exec(src);
  if (m) return { type: 'hr', raw: stripTail(m[0], '\n') };
  return null;
}

function tokBlockquote(lx, src) {
  const m = BLOCK.blockquote.exec(src);
  if (!m) return null;
  const lines = stripTail(m[0], '\n').split('\n');
  let rawAll = '';
  let textAll = '';
  const tokens = [];
  let rest = lines;
  for (;;) {
    let found = false;
    const chunk = [];
    let p = 0;
    for (p = 0; p < rest.length; p++) {
      if (O.blockquoteStart.test(rest[p])) {
        chunk.push(rest[p]);
        found = true;
      } else if (!found) {
        chunk.push(rest[p]);
      } else break;
    }
    rest = rest.slice(p);
    const joined = chunk.join('\n');
    const stripped = joined
      .replace(O.blockquoteMarkerWhitespace, (g, mark, ws) => mark + expandTabs(ws, mark.length))
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    rawAll = rawAll ? rawAll + '\n' + joined : joined;
    textAll = textAll ? textAll + '\n' + stripped : stripped;
    const savedTop = lx.top;
    lx.top = true;
    blockTokens(lx, stripped, tokens, true);
    lx.top = savedTop;
    if (rest.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      const inner = last;
      const tail = rest.join('\n');
      const merged = inner.raw + '\n' + tail.replace(O.blockquoteSetextReplace2, '');
      const rebuilt = tokBlockquote(lx, merged);
      tokens[tokens.length - 1] = rebuilt;
      const after = merged.substring(rebuilt.raw.length).replace(/^\n/, '');
      const afterLines = after ? after.split('\n').length : 0;
      const consumed = afterLines ? rest.slice(0, -afterLines) : rest;
      if (consumed.length > 0) {
        rawAll = rawAll + '\n' + consumed.join('\n');
      }
      textAll = textAll.substring(0, textAll.length - inner.text.length) + rebuilt.text;
      rest = rest.slice(consumed.length);
      if (rest.length > 0 && O.blockquoteStart.test(rest[0])) continue;
      break;
    } else if (last?.type === 'list') {
      const inner = last;
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
      continue;
    }
  }
  return { type: 'blockquote', raw: rawAll, tokens, text: textAll };
}

function tokList(lx, src) {
  const first = BLOCK.list.exec(src);
  if (!first) return null;
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
  for (; rest;) {
    let blankItem = false;
    let itemText = '';
    let m = itemRe.exec(rest);
    if (!m || BLOCK.hr.test(rest)) break;
    const itemStart = startOf();
    rest = rest.substring(m[0].length);
    let firstLine = m[2].split('\n', 1)[0];
    const markerLen = m[1].length;
    let content = firstLine.replace(O.leadingSpaceTab, (v) => expandTabs(v, markerLen));
    let nextLine = rest.split('\n', 1)[0];
    let empty = !content.trim();
    let indent = 0;
    if (empty) {
      indent = markerLen + 1;
    } else {
      indent = content.search(O.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemText = content.slice(indent);
      indent += markerLen;
    }
    if (empty && O.blankLine.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      blankItem = true;
    }
    if (!blankItem) {
      const nextBullet = O.nextBulletRegex(indent);
      const hrRe = O.hrRegex(indent);
      const fencesBegin = O.fencesBeginRegex(indent);
      const headingBegin = O.headingBeginRegex(indent);
      const htmlBegin = O.htmlBeginRegex(indent);
      const quoteBegin = O.blockquoteBeginRegex(indent);
      for (; rest;) {
        const line = rest.split('\n', 1)[0];
        nextLine = line;
        const expanded = line.replace(O.leadingSpaceTab, (v) => expandTabs(v));
        if (
          fencesBegin.test(line) || headingBegin.test(line) || htmlBegin.test(line) ||
          quoteBegin.test(line) || nextBullet.test(line) || hrRe.test(line)
        ) break;
        if (expanded.search(O.nonSpaceChar) >= indent || !line.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          if (
            empty ||
            content.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4 ||
            fencesBegin.test(content) || headingBegin.test(content) ||
            htmlBegin.test(content) || hrRe.test(content)
          ) break;
          let add = line;
          if (/^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(`${content}\n${line}`)) {
            add = '    ' + expanded.replace(/^ {0,3}/, '');
          }
          itemText += '\n' + add;
        }
        empty = !line.trim();
        rest = rest.substring(line.length + 1);
        content = expanded.slice(indent);
      }
    }
    const itemEnd = startOf();
    const itemRaw = src.slice(itemStart, itemEnd);
    if (!list.loose) {
      if (sawDoubleBlank) list.loose = true;
      else if (O.doubleBlankLine.test(itemRaw)) sawDoubleBlank = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: !!O.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(0, startOf()).trimEnd();
  // Tokenise each item's text as blocks.
  for (const item of list.items) {
    lx.top = false;
    item.tokens = blockTokens(lx, item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      if (spaces.length > 0 && spaces.some((t) => O.anyLine.test(t.raw))) list.loose = true;
    }
  }
  // Task list handling.
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph')) {
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
      if (cb) {
        const box = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = box.checked;
        if (list.loose) {
          if (
            item.tokens[0] &&
            ['paragraph', 'text'].includes(item.tokens[0].type) &&
            'tokens' in item.tokens[0] &&
            item.tokens[0].tokens
          ) {
            item.tokens[0].raw = box.raw + item.tokens[0].raw;
            item.tokens[0].text = box.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(box);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
          }
        } else {
          item.tokens.unshift(box);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return list;
}

function tokHtml(src) {
  const m = BLOCK.html.exec(src);
  if (m) {
    const raw = trimBlankTail(m[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      text: raw,
    };
  }
  return null;
}

function tokDef(src) {
  const m = BLOCK.def.exec(src);
  if (!m) return null;
  if (!O.startAngleBracket.test(m[2]) && parenScan(m[2], '()', '') !== -1) return null;
  const tag = normLabel(m[1]);
  let href = m[2] ? m[2].replace(O.hrefBrackets, '$1').replace(INLINE.anyPunct, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunct, '$1') : m[3];
  return { type: 'def', tag, raw: stripTail(m[0], '\n'), href, title };
}

function tokTable(lx, src) {
  const m = BLOCK.table.exec(src);
  if (!m || !O.tableDelimiter.test(m[2])) return null;
  const headerCells = splitCells(m[1]);
  const alignsRaw = m[2].replace(O.tableAlignChars, '').split('|');
  const bodyLines = m[3]?.trim() ? m[3].replace(O.tableRowBlankLine, '').split('\n') : [];
  const table = { type: 'table', raw: stripTail(m[0], '\n'), header: [], align: [], rows: [] };
  if (headerCells.length !== alignsRaw.length) return null;
  for (const a of alignsRaw) {
    if (O.tableAlignRight.test(a)) table.align.push('right');
    else if (O.tableAlignCenter.test(a)) table.align.push('center');
    else if (O.tableAlignLeft.test(a)) table.align.push('left');
    else table.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({
      text: headerCells[i],
      tokens: queueInline(lx, headerCells[i], []),
      header: true,
      align: table.align[i],
    });
  }
  for (const line of bodyLines) {
    table.rows.push(
      splitCells(line, table.header.length).map((cell, j) => ({
        text: cell,
        tokens: queueInline(lx, cell, []),
        header: false,
        align: table.align[j],
      })),
    );
  }
  return table;
}

function tokLheading(lx, src) {
  const m = BLOCK.lheading.exec(src);
  if (m) {
    const text = m[1].trim();
    return {
      type: 'heading',
      raw: stripTail(m[0], '\n'),
      depth: m[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: queueInline(lx, text, []),
    };
  }
  return null;
}

function tokParagraph(lx, src) {
  const m = BLOCK.paragraph.exec(src);
  if (m) {
    const raw = m[0];
    let text = raw.charAt(raw.length - 1) === '\n' ? raw.slice(0, -1) : raw;
    return { type: 'paragraph', raw, text, tokens: queueInline(lx, text, []) };
  }
  return null;
}

function tokText(lx, src) {
  const m = BLOCK.text.exec(src);
  if (m) {
    return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(lx, m[0], []) };
  }
  return null;
}

// ---------------------------------------------------------------- block pass

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
    if (src.indexOf('|') === -1) return false;
    const nl = src.indexOf('\n');
    if (nl === -1) return false;
    const nl2 = src.indexOf('\n', nl + 1);
    const line2 = src.slice(nl + 1, nl2 === -1 ? src.length : nl2);
    return line2.indexOf('|') !== -1 && line2.indexOf('-') !== -1;
  };
  const hasSetext = () => {
    // A setext underline must sit on a line of the upcoming paragraph
    // (the text cannot cross a blank line), so scan lines only until
    // the first blank line or a line that clearly starts another block.
    let pos = src.indexOf('\n');
    if (pos === -1) return false;
    while (pos !== -1) {
      const next = src.indexOf('\n', pos + 1);
      const line = src.slice(pos + 1, next === -1 ? src.length : next);
      let i = 0;
      while (i < 3 && line.charCodeAt(i) === 32) i++;
      const c = line.charCodeAt(i);
      if (c === 61 || c === 45) {
        let j = i;
        while (j < line.length && line.charCodeAt(j) === c) j++;
        let k = j;
        while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
        if (k === line.length && j > i) return true;
      }
      if (line.trim() === '') return false;
      if (c === 35 || c === 62 || c === 60) return false;
      if (
        (c === 96 && line.charCodeAt(i + 1) === 96 && line.charCodeAt(i + 2) === 96) ||
        (c === 126 && line.charCodeAt(i + 1) === 126 && line.charCodeAt(i + 2) === 126)
      ) return false;
      pos = next;
    }
    return false;
  };
  for (; src;) {
    if (src.length < shortest) shortest = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let tok;
    const c0 = src.charCodeAt(0);
    if ((c0 === 32 || c0 === 9 || c0 === 10) && (tok = tokSpace(src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    const i3 = at3();
    if (
      (src.startsWith('    ') || src.charCodeAt(i3) === 9) &&
      (tok = tokCode(src))
    ) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        lx.inlineQueue[lx.inlineQueue.length - 1].src = last.text;
      } else tokens.push(tok);
      continue;
    }
    const ch3 = src.charCodeAt(i3);
    if (
      ((ch3 === 96 && src.charCodeAt(i3 + 1) === 96 && src.charCodeAt(i3 + 2) === 96) ||
        (ch3 === 126 && src.charCodeAt(i3 + 1) === 126 && src.charCodeAt(i3 + 2) === 126)) &&
      (tok = tokFences(src))
    ) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (ch3 === 35 && (tok = tokHeading(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((ch3 === 45 || ch3 === 95 || ch3 === 42) && (tok = tokHr(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (ch3 === 62 && (tok = tokBlockquote(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (
      (ch3 === 42 || ch3 === 43 || ch3 === 45 || (ch3 >= 48 && ch3 <= 57)) &&
      (tok = tokList(lx, src))
    ) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (ch3 === 60 && (tok = tokHtml(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (ch3 === 91 && (tok = tokDef(src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.raw;
        lx.inlineQueue[lx.inlineQueue.length - 1].src = last.text;
      } else {
        if (!lx.links[tok.tag]) {
          lx.links[tok.tag] = { href: tok.href, title: tok.title };
          lx.linkCount++;
        }
        tokens.push(tok);
      }
      continue;
    }
    if (hasTableShape() && (tok = tokTable(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (hasSetext() && (tok = tokLheading(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (lx.top && (tok = tokParagraph(lx, src))) {
      const last = tokens[tokens.length - 1];
      if (mergePara && last?.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        lx.inlineQueue.pop();
        lx.inlineQueue[lx.inlineQueue.length - 1].src = last.text;
      } else {
        tokens.push(tok);
      }
      mergePara = false;
      src = src.substring(tok.raw.length);
      continue;
    }
    if ((tok = tokText(lx, src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        lx.inlineQueue.pop();
        lx.inlineQueue[lx.inlineQueue.length - 1].src = last.text;
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
function scanClosers(s) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const ch = s[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : s[i - 1];
    let j = i + 1;
    for (; j < n && s[j] === ch;) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else em[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: s, em, del };
}

// Mask a string for emphasis scanning: replace the insides of links, code
// spans and raw HTML with filler, keeping the length identical so indices
// still line up with the original.
function maskForEmphasis(lx, src) {
  // Without '[', '`', '<' or a backslash there is nothing to mask: no
  // link, code span, raw HTML tag or escaped punctuation exists, so the
  // masked string is the source itself.
  const hasBracket = src.includes('[');
  const hasTick = src.includes('`');
  const hasLt = src.includes('<');
  const hasBackslash = src.includes('\\');
  if (!hasBracket && !hasTick && !hasLt && !hasBackslash) return src;
  let t = src;
  if (lx.linkCount > 0 && hasBracket && src.includes(']')) {
    const re = INLINE.reflinkSearch;
    const maskOne = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(lx.links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(lx, inner)) {
          return '[' + inner.replace(re, maskOne) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(re, maskOne);
  }
  if (hasTick || hasBackslash) {
    t = t.replace(INLINE.anyPunctOutsideCode, (m, ticks, punct) =>
      punct ? '+'.repeat(m.length)
        : ticks ? ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
        : m,
    );
  }
  if (hasTick || hasLt || (hasBracket && src.includes(']('))) {
    t = t.replace(INLINE.blockSkip, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  }
  return t;
}

function linkInText(lx, s) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(INLINE.reflinkSearch)) {
    const r = m[0];
    const o = r.lastIndexOf('[');
    if (
      !(r.charAt(0) === '!' || !Object.hasOwn(lx.links, normLabel(r.slice(o + 1, -1)))) &&
      !(o > 1 && linkInText(lx, r.slice(1, o - 1)))
    ) return true;
  }
  return false;
}

// Last possible closer index for `ch` ('*' or '_') in the masked string,
// consulting the per-tokeniser cache stack first.
function lastEmCloser(lx, masked, ch) {
  const top = lx.emStack[lx.emStack.length - 1];
  if (top && top.maskedSrc === masked) {
    if (top.em === null) top.em = scanClosers(masked).em;
    return top.em[ch];
  }
  return scanClosers(masked).em[ch];
}

function lastDelCloser(lx, masked) {
  const top = lx.emStack[lx.emStack.length - 1];
  if (top && top.maskedSrc === masked) {
    if (top.del === null) top.del = scanClosers(masked).del;
    return top.del;
  }
  return scanClosers(masked).del;
}

function inlineTokens(lx, src, tokens = []) {
  const savedParen = lx.linkParenPossible;
  lx.linkParenPossible = savedParen && src.includes(')');
  try {
    const masked =
      src.includes('*') || src.includes('_') || src.includes('~')
        ? maskForEmphasis(lx, src)
        : src;
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
function isUrlStart(src) {
  const c = src.charCodeAt(0);
  if (
    !((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 46 || c === 95 || c === 43 || c === 45)
  ) return false;
  if (
    /^www\.|^https?:\/\/|^ftp:\/\/|^mailto:|^xmpp:/i.test(src)
  ) return true;
  for (let i = 1; i < src.length; i++) {
    const ch = src.charCodeAt(i);
    if (ch === 64) return true; // '@': a bare email may start here
    if (ch <= 32 || ch === 60 || ch === 91 || ch === 93 || ch === 96 || ch === 42 ||
      ch === 126 || ch === 92 || ch === 33 || ch === 40 || ch === 41) return false;
    if (i >= 80) return true; // undecided: let the regex decide
  }
  return false;
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
    // at this position are attempted, in marked's order.
    const c0 = src.charCodeAt(0);
    let tok = null;
    if (c0 === 92) { // backslash: escape, else a hard break
      tok = tokEscape(src) || tokBr(src);
    } else if (c0 === 60) { // '<': raw tag, else autolink
      tok = tokTag(lx, src) || tokAutolink(src);
    } else if (c0 === 91 || (c0 === 33 && src.charCodeAt(1) === 91)) { // '[' or '!['
      tok = tokLink(lx, src) || tokReflink(lx, src);
    } else if (c0 === 42 || c0 === 95) { // '*' '_': emphasis
      tok = tokEmStrong(lx, src, masked, prev);
    } else if (c0 === 96) { // '`': code span
      tok = tokCodespan(src);
    } else if (c0 === 126) { // '~': strikethrough
      tok = tokDel(lx, src, masked, prev);
    } else if (c0 === 32) { // space: a hard break is the only match
      tok = tokBr(src);
    } else if (!lx.inLink && isUrlStart(src)) {
      tok = tokUrl(src);
    }
    if (tok) {
      src = src.substring(tok.raw.length);
      if (tok.type === 'text') {
        const last = out[out.length - 1];
        if (last?.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
          continue;
        }
      }
      out.push(tok);
      continue;
    }
    if ((tok = tokInlineText(lx, src))) {
      src = src.substring(tok.raw.length);
      if (tok.raw.slice(-1) !== '_') prev = tok.raw.slice(-1);
      justText = true;
      const last = out[out.length - 1];
      if (last?.type === 'text') {
        last.raw += tok.raw;
        last.text += tok.text;
      } else out.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return out;
}

// ---------------------------------------------------------------- inline tokenisers

function tokEscape(src) {
  const m = INLINE.escape.exec(src);
  if (m) return { type: 'escape', raw: m[0], text: m[1] };
  return null;
}

function tokTag(lx, src) {
  const m = INLINE.tag.exec(src);
  if (!m) return null;
  if (!lx.inLink && O.startATag.test(m[0])) lx.inLink = true;
  else if (lx.inLink && O.endATag.test(m[0])) lx.inLink = false;
  if (!lx.inRawBlock && O.startPreScriptTag.test(m[0])) lx.inRawBlock = true;
  else if (lx.inRawBlock && O.endPreScriptTag.test(m[0])) lx.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: lx.inLink, inRawBlock: lx.inRawBlock, block: false, text: m[0] };
}

// Does the link text contain a raw HTML tag that runs past its end?
// (Such a link is not a link at all.)
function linkTextHasRawTag(fullSrc, linkText, offset) {
  if (!linkText.includes('<')) return false;
  for (let i = 0; i < linkText.length; i++) {
    if (linkText[i] === '\\') { i++; continue; }
    if (linkText[i] === '`') {
      const m = INLINE.code.exec(linkText.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (linkText[i] !== '<') continue;
    const rest = fullSrc.slice(offset + i);
    const m = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (m) {
      if (m[0].length > linkText.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// Build a link or image token, tokenising its text. Returns undefined when
// the text itself already emitted a link (nested links are dropped).
function makeLink(lx, match, ref, raw) {
  const href = ref.href;
  const title = ref.title || null;
  const text = match[1].replace(O.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = lx.inLink;
  const savedEmitted = lx.linkEmitted;
  const savedRawBlock = lx.inRawBlock;
  lx.inLink = true;
  lx.linkEmitted = false;
  const tokens = inlineTokens(lx, text);
  const emittedInside = lx.linkEmitted;
  lx.linkEmitted = savedEmitted;
  lx.inLink = savedInLink;
  if (!isImage) {
    if (emittedInside) {
      lx.inRawBlock = savedRawBlock;
      return undefined;
    }
    lx.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function tokLink(lx, src) {
  if (lx.linkParenPossible === false) return null;
  const m = INLINE.link.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkTextHasRawTag(src, m[1], bang)) return null;
  let href = m[2].trim();
  if (O.startAngleBracket.test(href)) {
    if (!O.endAngleBracket.test(href)) return null;
    const stripped = stripTail(href.slice(0, -1), '\\');
    if ((href.length - stripped.length) % 2 === 0) return null;
  } else {
    const p = parenScan(m[2], '()', '');
    if (p === -2) return null;
    if (p > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + p;
      m[2] = m[2].substring(0, p);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = '';
    }
  }
  const rawStripped = stripTail(m[0].slice(0, -1), '\\');
  if ((m[0].length - rawStripped.length) % 2 === 0) return null;
  let dest = m[2];
  let title = '';
  title = m[3] ? m[3].slice(1, -1) : '';
  dest = dest.trim();
  if (O.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
  return makeLink(
    lx,
    m,
    { href: dest && dest.replace(INLINE.anyPunct, '$1'), title: title && title.replace(INLINE.anyPunct, '$1') },
    m[0],
  );
}

function tokReflink(lx, src) {
  let m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkTextHasRawTag(src, m[1], bang)) return null;
  const ref = lx.links[normLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return makeLink(lx, m, ref, m[0]);
}

function tokEmStrong(lx, src, masked, prev) {
  const m = INLINE.emStrongLDelim.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const delim = m[0][0];
  const wasDelim = prev === delim;
  const offset = masked.length - src.length;
  let left = offset;
  for (; left > 0 && masked[left - 1] === delim;) left--;
  const beforeRun = [...masked.slice(Math.max(0, left - 2), left)].at(-1) ?? '';
  const beforeIsDelimOrPunct =
    beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
  if (left < offset) prev = beforeRun;
  const prevIsPunct = left < offset ? beforeIsDelimOrPunct : !!INLINE.punctuation.exec(prev);
  if (m[4] && O.unicodeAlphaNumeric.test(prev)) return null;
  const afterPunct = m[1] || m[3] || '';
  if (!afterPunct || !prev || prevIsPunct) {
    let runLen = [...m[0]].length - 1;
    let g;
    let b;
    let openLeft = runLen;
    let skipped = 0;
    const total = offset - left + runLen;
    const canOpenStrong = !!beforeRun.trim() && (!!afterPunct || (delim === '*' && !beforeIsDelimOrPunct));
    if (delim !== '*' && delim !== '_') return null;
    const closerRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const lastCloser = lastEmCloser(lx, masked, delim);
    const needPos = masked.length - src.length + runLen;
    if (lastCloser < needPos) return null;
    const rest = masked.slice(-src.length + runLen);
    const limit = lastCloser - needPos;
    for (closerRe.lastIndex = 0; ;) {
      const cm = closerRe.exec(rest);
      if (cm === null || cm.index > limit) break;
      g = cm[1] || cm[2] || cm[3] || cm[4] || cm[5] || cm[6];
      if (!g) continue;
      b = [...g].length;
      if (cm[3] || cm[4]) { openLeft += b; continue; }
      else if (cm[5] || cm[6] || canOpenStrong) {
        if (wasDelim && (cm[5] || cm[6])) break;
        if (total % 3 && !((total + b) % 3)) { skipped += b; continue; }
      }
      if ((openLeft -= b) > 0) continue;
      b = Math.min(b, b + openLeft + skipped);
      const firstLen = [...cm[0]][0].length;
      const rawLen = runLen + cm.index + firstLen + b;
      const raw = src.slice(0, rawLen);
      if (Math.min(runLen, b) % 2) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: inlineTokens(lx, inner) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: inlineTokens(lx, inner) };
    }
  }
  return null;
}

function tokCodespan(src) {
  const m = INLINE.code.exec(src);
  if (!m) return null;
  let text = m[2].replace(O.newLineCharGlobal, ' ');
  const hasNonSpace = O.nonSpaceChar.test(text);
  const wrapped = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
  if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: m[0], text };
}

function tokBr(src) {
  const m = INLINE.br.exec(src);
  if (m) return { type: 'br', raw: m[0] };
  return null;
}

function tokDel(lx, src, masked, prev) {
  const m = INLINE.delLDelim.exec(src);
  if (!m) return null;
  if (!((m[1] || '') || !prev || INLINE.punctuation.exec(prev))) return null;
  const runLen = [...m[0]].length - 1;
  let openLeft = runLen;
  const lastCloser = lastDelCloser(lx, masked);
  const needPos = masked.length - src.length + runLen;
  if (lastCloser < needPos) return null;
  const rest = masked.slice(-src.length + runLen);
  const limit = lastCloser - needPos;
  const closerRe = INLINE.delRDelim;
  for (closerRe.lastIndex = 0; ;) {
    const cm = closerRe.exec(rest);
    if (cm === null || cm.index > limit) break;
    const g = cm[1] || cm[2] || cm[3] || cm[4] || cm[5] || cm[6];
    if (!g) continue;
    const b = [...g].length;
    if (b !== runLen) continue;
    if (cm[3] || cm[4]) { openLeft += b; continue; }
    if ((openLeft -= b) > 0) continue;
    const useLen = Math.min(b, b + openLeft);
    const firstLen = [...cm[0]][0].length;
    const raw = src.slice(0, runLen + cm.index + firstLen + useLen);
    const inner = raw.slice(runLen, -runLen);
    return { type: 'del', raw, text: inner, tokens: inlineTokens(lx, inner) };
  }
  return null;
}

function tokAutolink(src) {
  const m = INLINE.autolink.exec(src);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[1];
    href = 'mailto:' + text;
  } else {
    text = m[1];
    href = text;
  }
  return {
    type: 'link',
    raw: m[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

function tokUrl(src) {
  let m = INLINE.url.exec(src);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let cur;
    do {
      cur = m[0];
      m[0] = INLINE.backpedal.exec(m[0])?.[0] ?? '';
    } while (cur !== m[0]);
    text = m[0];
    href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
  }
  return {
    type: 'link',
    raw: m[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
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
  let s = at - 1;
  while (s >= 0 && isEmailChar(src.charCodeAt(s))) s--;
  s++;
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
  for (const cand of cands) {
    if (cand.www) {
      const pc = src.charCodeAt(cand.pos - 1);
      if (pc !== 32 && pc !== 9 && pc !== 42 && pc !== 95 && pc !== 126 && pc !== 40) continue;
    }
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

function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    const render = BLOCK_RENDER[tok.type];
    if (render === undefined) throw new Error('Token with "' + tok.type + '" type was not found.');
    out += render(tok);
  }
  return out;
}

// ---------------------------------------------------------------- entry point

export function parse(markdown) {
  const lx = newLexer();
  const src = markdown.replace(O.carriageReturn, '\n');
  const tokens = blockTokens(lx, src, []);
  for (let i = 0; i < lx.inlineQueue.length; i++) {
    const item = lx.inlineQueue[i];
    lx.inRawBlock = false;
    inlineTokens(lx, item.src, item.tokens);
  }
  lx.inlineQueue = [];
  return renderTokens(tokens);
}
