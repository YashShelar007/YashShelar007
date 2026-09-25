#!/usr/bin/env node
/**
 * Renders the header and the profile cards as SVG into assets/: the cards from
 * the GitHub API, the header's Claude Code strip from the public stats gist.
 *
 * Why this exists: the README used to embed two images from the shared public
 * github-readme-stats instance. That is somebody else's free Vercel deployment,
 * it gets paused under load, and when it does every card on this profile renders
 * as broken-image alt text. On 2026-09-02 it returned 503 DEPLOYMENT_PAUSED for
 * the bare `?username=...` URL, so the fault was the host and not our parameters.
 *
 * Generating the cards here is strictly better than calling that service:
 *   - it cannot 503
 *   - the palette is exact rather than approximated through query parameters
 *   - one source produces a light and a dark cut, which is what the header does
 *   - no rate limit, and no third party seeing traffic from the profile page
 *
 * Two rules this file exists to keep:
 *
 *   1. EVERY COUNT IS EXPLICITLY PUBLIC-ONLY. Search counts without an
 *      `is:public` qualifier return whatever the *viewer* can see, so the same
 *      code run with the owner's PAT and with the Actions GITHUB_TOKEN would
 *      report different numbers and neither would be reproducible by a reader.
 *      Locally, `author:YashShelar007 type:pr` returns 733 and
 *      `author:YashShelar007 type:pr is:public` returns 20. The difference is
 *      private work, and a card nobody else can verify is not a card.
 *
 *   2. A FAILED FETCH IS A FAILURE, NEVER A ZERO. If anything throws, nothing is
 *      written and the workflow goes red with the last known-good cards still
 *      committed. A card that quietly renders 0 stars because we got rate
 *      limited is worse than no card at all.
 *
 * Usage:
 *   GITHUB_TOKEN=... node scripts/profile-cards.mjs [--out DIR] [--user LOGIN] [--json]
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const API = "https://api.github.com";
const GIST =
  "https://gist.github.com/YashShelar007/9c16505eb7149f47a0c80396613d69a2";
const CLAUDE_STATS = `${GIST.replace("gist.github.com", "gist.githubusercontent.com")}/raw/stats.json`;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const USER = flag("user", "YashShelar007");
const OUT = flag("out", "assets");
const PRINT_JSON = args.includes("--json");

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) {
  throw new Error(
    "GITHUB_TOKEN is required. In Actions the built-in token is enough.",
  );
}

/* ------------------------------------------------------------------ fetching */

async function api(path, { search = false } = {}) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "user-agent": `${USER}-profile-cards`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub API ${res.status} ${res.statusText} for ${url}\n${await res.text()}`,
    );
  }
  const body = await res.json();
  if (search && body.incomplete_results) {
    // A truncated search result is an undercount wearing the costume of a count.
    throw new Error(
      `Search returned incomplete_results for ${url}; refusing to render a number that is wrong.`,
    );
  }
  return { body, link: res.headers.get("link") || "" };
}

async function paginate(path) {
  const out = [];
  let next = `${API}${path}`;
  while (next) {
    const { body, link } = await api(next);
    out.push(...body);
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;
  }
  return out;
}

// `is:public` is not optional. See rule 1 at the top of this file.
async function searchCount(endpoint, query) {
  const { body } = await api(
    `/search/${endpoint}?q=${encodeURIComponent(query)}&per_page=1`,
    { search: true },
  );
  return body.total_count;
}

async function collect() {
  const repos = (
    await paginate(`/users/${USER}/repos?per_page=100&type=owner`)
  ).filter((r) => !r.fork && !r.private);

  const languages = {};
  const repoCount = {};
  for (const r of repos) {
    const { body } = await api(`/repos/${r.full_name}/languages`);
    for (const [lang, bytes] of Object.entries(body)) {
      if (!bytes) continue;
      languages[lang] = (languages[lang] || 0) + bytes;
      repoCount[lang] = (repoCount[lang] || 0) + 1;
    }
  }

  const [commits, prs, merged, issues] = await Promise.all([
    searchCount("commits", `author:${USER} is:public`),
    searchCount("issues", `author:${USER} is:public type:pr`),
    searchCount("issues", `author:${USER} is:public type:pr is:merged`),
    searchCount("issues", `author:${USER} is:public type:issue`),
  ]);

  return {
    user: USER,
    repos: repos.length,
    stars: repos.reduce((a, r) => a + r.stargazers_count, 0),
    commits,
    prs,
    merged,
    issues,
    languages,
    repoCount,
  };
}

/* Claude Code usage, from the gist a local job publishes. Same rule 2 as the
 * GitHub counts: anything missing or malformed throws, nothing is written, and
 * the last good header stays committed. A header that says 0 tokens because a
 * CDN hiccuped is a false claim on the first thing a visitor reads.
 */
async function collectClaude() {
  const res = await fetch(CLAUDE_STATS, {
    headers: { "user-agent": `${USER}-profile-cards` },
  });
  if (!res.ok)
    throw new Error(`Claude stats ${res.status} ${res.statusText} for ${CLAUDE_STATS}`);
  const s = await res.json();
  const count = (v, name) => {
    if (!Number.isFinite(v) || v < 0)
      throw new Error(`Claude stats: ${name} is ${JSON.stringify(v)}; refusing to render it.`);
    return v;
  };
  const tokens = count(s.tokens?.total, "tokens.total");
  if (tokens === 0) throw new Error("Claude stats: tokens.total is 0; refusing to render it.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.first_active ?? ""))
    throw new Error(`Claude stats: first_active is ${JSON.stringify(s.first_active)}.`);
  return {
    tokens,
    sessions: count(s.sessions, "sessions"),
    activeDays: count(s.active_days, "active_days"),
    streak: count(s.streak?.current, "streak.current"),
    longest: count(s.streak?.longest, "streak.longest"),
    since: s.first_active,
    machines: Array.isArray(s.machines) ? s.machines.length : 0,
  };
}

/* --------------------------------------------------------- language selection
 *
 * The old card was capped at 8, which hid HCL/Terraform, Shell, Swift, TeX,
 * PowerShell and Dockerfile behind a number picked for no reason.
 *
 * The rule instead of a number: a language earns a row either by VOLUME (at
 * least 0.5% of all bytes) or by RECURRENCE (it appears in two or more
 * repositories). Volume catches a language used heavily in one place; recurrence
 * catches one used lightly but everywhere, which is exactly the signal a byte
 * count on its own destroys. Shell is 0.45% of the bytes and would have been cut
 * by a share threshold alone, but it is in four repositories, so it is real. A
 * single vendored file in a single repository satisfies neither and stays out.
 *
 * MAX_ROWS caps the card's height so it cannot grow without bound as he ships.
 * Anything excluded is summed into "Other" rather than dropped, so the bar still
 * accounts for 100% of the bytes measured.
 */
const MIN_SHARE = 0.005;
const MIN_REPOS = 2;
const MAX_ROWS = 16;

function selectLanguages({ languages, repoCount }) {
  const total = Object.values(languages).reduce((a, b) => a + b, 0);
  if (!total)
    throw new Error(
      "No language bytes returned; refusing to render an empty card.",
    );

  const ranked = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  const kept = [];
  let other = 0;

  for (const [name, bytes] of ranked) {
    const earnsIt = bytes / total >= MIN_SHARE || repoCount[name] >= MIN_REPOS;
    if (earnsIt && kept.length < MAX_ROWS)
      kept.push({ name, bytes, repos: repoCount[name] });
    else other += bytes;
  }
  if (other > 0) kept.push({ name: "Other", bytes: other, repos: 0 });

  return { total, rows: kept.map((r) => ({ ...r, share: r.bytes / total })) };
}

/* -------------------------------------------------------------------- palette
 *
 * Lifted from the original hand-drawn header. Cyan (`live`) is reserved for
 * things that are live, which on this profile means availability and the
 * nightly Claude Code figures, and is deliberately absent from the cards.
 */
const THEMES = {
  dark: {
    bg: "#0D0B08",
    hairline: "#282623",
    bracket: "#765723",
    accent: "#EFB146",
    ink: "#F6F5F2",
    muted: "#99938A",
    // The ramp ends on `muted` rather than on a near-black, because a swatch the
    // reader cannot pick out is not a legend entry. `muted` is legible on this
    // ground by definition: it is the colour every label is already set in.
    rampEnd: "#99938A",
    tick: "#3A3835",
    live: "#36DCEC",
  },
  light: {
    bg: "#FBFAF8",
    hairline: "#E0DDDA",
    bracket: "#D0B285",
    accent: "#B47825",
    ink: "#1D1A16",
    muted: "#6D6860",
    rampEnd: "#6D6860",
    tick: "#CFCBC6",
    live: "#047781",
  },
};

const SANS =
  "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";

const XML_ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

// Language names come from the API and can contain `&`, `<`, `+`, `#`. Anything
// outside printable ASCII becomes a numeric reference so the file stays
// byte-identical regardless of how a shell or editor handles encoding.
const esc = (s) =>
  String(s)
    .replace(/[&<>"']/g, (c) => XML_ENTITIES[c])
    .replace(/[^\x20-\x7E]/g, (c) => `&#${c.codePointAt(0)};`);

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const c = (x, y) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`.toUpperCase();
};

// One hue, ranked. Twelve distinct hues would have broken the palette; a ramp
// from the accent toward the hairline says "ordered" rather than "categorical".
const ramp = (theme, i, n) =>
  mix(theme.accent, theme.rampEnd, n <= 1 ? 0 : (i / (n - 1)) ** 0.85);

const num = (n) => n.toLocaleString("en-US");
const size = (b) =>
  b >= 1_000_000
    ? `${(b / 1_000_000).toFixed(1)} MB`
    : `${Math.round(b / 1000)} KB`;

const text = (
  x,
  y,
  s,
  { font = MONO, size: fs = 11.5, fill, ls = 1.8, weight, anchor } = {},
) =>
  `  <text x="${x}" y="${y}" font-family="${font}" font-size="${fs}"` +
  (weight ? ` font-weight="${weight}"` : "") +
  (anchor ? ` text-anchor="${anchor}"` : "") +
  ` letter-spacing="${ls}" fill="${fill}">${esc(s)}</text>`;

const rule = (x1, y, x2, stroke) =>
  `  <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${stroke}" stroke-width="1"/>`;

// The corner brackets from the header, so the cards read as the same object.
const brackets = (w, h, c) =>
  [
    `  <path d="M22 40 L22 22 L40 22" fill="none" stroke="${c}" stroke-width="1.6"/>`,
    `  <path d="M${w - 40} 22 L${w - 22} 22 L${w - 22} 40" fill="none" stroke="${c}" stroke-width="1.6"/>`,
    `  <path d="M22 ${h - 40} L22 ${h - 22} L40 ${h - 22}" fill="none" stroke="${c}" stroke-width="1.6"/>`,
    `  <path d="M${w - 22} ${h - 40} L${w - 22} ${h - 22} L${w - 40} ${h - 22}" fill="none" stroke="${c}" stroke-width="1.6"/>`,
  ].join("\n");

const frame = (w, h, t) =>
  `  <rect width="${w}" height="${h}" fill="${t.bg}"/>\n` +
  `  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="none" stroke="${t.hairline}" stroke-width="1"/>\n` +
  brackets(w, h, t.bracket);

const doc = (w, h, title, desc, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">\n` +
  `  <title id="t">${esc(title)}</title>\n` +
  `  <desc id="d">${esc(desc)}</desc>\n\n` +
  `${body}\n</svg>\n`;

const W = 1200;
const PAD = 48;
const INNER = W - PAD * 2;

/* -------------------------------------------------------------------- header
 *
 * The faceplate at the top of the README. It was a hand-drawn SVG until the
 * Claude Code figures joined it; it is generated now so those figures can be
 * live without a third-party badge. Everything above the Claude strip is the
 * original drawing, coordinate for coordinate.
 *
 * The strip reuses the metric row's five-column grid and type: amber numerals,
 * small-caps labels, hairline dividers. Its label sits where a tile would, and
 * the cyan "updated nightly" readout mirrors AVAILABLE in the top-right corner,
 * because both are the only live things on the card.
 */
const compact = (n) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : num(n);

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY",
  "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

const METRICS = [
  ["200+", "USERS ON VANTION", "BUILT FROM ZERO"],
  ["~90%", "OF IMPLEMENTATION", "SOLE ENGINEER"],
  ["65%", "FEWER ACCESS", "REQUESTS · AWS ORG"],
  ["5×", "LOWER QUERY", "LATENCY · PGVECTOR"],
  ["43k+", "SCHOLARSHIPS", "IN HYBRID SEARCH"],
];

function renderHeader(c, t) {
  const H = 496;
  const step = INNER / METRICS.length;
  const col = (i) => (PAD + i * step).toFixed(1);
  const divider = (x, y1, y2) =>
    `  <line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${t.hairline}" stroke-width="1"/>`;
  const tile = (i, top, [value, l1, l2]) => [
    ...(i > 0 ? [divider(col(i), top + 22, top + 108)] : []),
    text(col(i), top + 56, value, { size: 38, ls: 0.5, fill: t.accent, weight: 600 }),
    text(col(i), top + 82, l1, { fill: t.muted }),
    text(col(i), top + 99, l2, { fill: t.muted }),
  ];

  const parts = [
    `  <rect width="${W}" height="${H}" fill="${t.bg}"/>`,
    `  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="${t.hairline}" stroke-width="1"/>`,
  ];
  // Ruler ticks along the top edge, a major one on every tile boundary.
  for (let i = 0; i <= 60; i++) {
    const x = (PAD + i * 18.4).toFixed(1);
    const major = i % 5 === 0;
    parts.push(
      `  <line x1="${x}" y1="0" x2="${x}" y2="${major ? 11 : 6}" stroke="${major ? t.tick : t.hairline}" stroke-width="1"/>`,
    );
  }
  parts.push(brackets(W, H, t.bracket), "");

  parts.push(
    text(PAD, 96, "YASH SHELAR", { font: SANS, size: 46, weight: 650, ls: 5, fill: t.ink }),
    `  <line x1="${PAD}" y1="116" x2="300" y2="116" stroke="${t.accent}" stroke-width="2"/>`,
    text(PAD, 142, "AI INFRASTRUCTURE ENGINEER", { font: SANS, size: 14.5, weight: 500, ls: 2.6, fill: t.muted }),
    "",
    text(1130, 90, "AVAILABLE", { size: 12, ls: 3, fill: t.live, anchor: "end" }),
    `  <circle cx="1145" cy="86" r="4.5" fill="${t.live}"/>`,
    text(W - PAD, 116, "AI INFRASTRUCTURE ROLES", { ls: 2.4, fill: t.muted, anchor: "end" }),
    "",
    rule(PAD, 176, W - PAD, t.hairline),
  );
  METRICS.forEach((m, i) => parts.push(...tile(i, 176, m)));
  parts.push(rule(PAD, 302, W - PAD, t.hairline), "");

  // The Claude Code strip.
  const [y, m] = c.since.split("-");
  const streakNote =
    c.streak > 0 && c.streak === c.longest
      ? "CURRENT, LONGEST YET"
      : `LONGEST ${num(c.longest)} DAYS`;
  parts.push(
    text(PAD, 358, "CLAUDE CODE", { size: 13, ls: 3.4, fill: t.accent, weight: 600 }),
    text(PAD, 384, `SINCE ${MONTHS[Number(m) - 1]} ${y}`, { fill: t.muted }),
  );
  if (c.machines > 1)
    parts.push(text(PAD, 401, `ACROSS ${c.machines} MACHINES`, { fill: t.muted }));
  parts.push(
    ...tile(1, 302, [compact(c.tokens), "TOKENS PROCESSED", "INPUT, OUTPUT, CACHE"]),
    ...tile(2, 302, [num(c.sessions), "SESSIONS", `OVER ${num(c.activeDays)} ACTIVE DAYS`]),
    ...tile(3, 302, [num(c.streak), "DAY STREAK", streakNote]),
    text(1130, 352, "UPDATED NIGHTLY", { size: 12, ls: 3, fill: t.live, anchor: "end" }),
    `  <circle cx="1145" cy="348" r="4.5" fill="${t.live}"/>`,
    text(W - PAD, 378, "FROM A PUBLIC GIST", { ls: 2.4, fill: t.muted, anchor: "end" }),
    `  <a href="${GIST}">`,
    "  " + text(PAD, 440, "COUNTED ONCE PER RESPONSE, THE BILLED FIGURE. FULL METHOD IN THE GIST.", { size: 11, ls: 1.9, fill: t.muted }),
    `  </a>`,
    rule(PAD, 458, W - PAD, t.hairline),
    "",
    text(PAD, 482, "PHOENIX, ARIZONA · UNITED STATES", { size: 11, ls: 1.9, fill: t.muted }),
    text(W - PAD, 482, "FULL-TIME ONLY · REQUIRES VISA SPONSORSHIP", { size: 11, ls: 1.9, fill: t.muted, anchor: "end" }),
  );

  return doc(
    W,
    H,
    "Yash Shelar · AI Infrastructure Engineer",
    "Faceplate: name, role, availability, five measured results from production work, " +
      `and Claude Code usage: ${compact(c.tokens)} tokens processed, ${num(c.sessions)} sessions, ` +
      `a ${num(c.streak)} day streak, counted once per response and updated nightly.`,
    parts.join("\n"),
  );
}

/* ---------------------------------------------------------------- stats card */


function renderStats(data, t) {
  const H = 224;
  const cells = [
    [num(data.stars), "STARS", "EARNED"],
    [num(data.commits), "COMMITS", "AUTHORED"],
    [num(data.prs), "PULL", "REQUESTS"],
    [num(data.merged), "OF THOSE", "MERGED"],
    [num(data.issues), "ISSUES", "OPENED"],
    [num(data.repos), "PUBLIC", "REPOSITORIES"],
  ];
  const step = INNER / cells.length;

  const parts = [frame(W, H, t)];
  parts.push(
    text(PAD, 54, "PUBLIC GITHUB ACTIVITY", {
      size: 13,
      ls: 3.4,
      fill: t.accent,
      weight: 600,
    }),
  );
  parts.push(
    text(W - PAD, 54, `GITHUB.COM/${data.user.toUpperCase()}`, {
      size: 11,
      ls: 2.2,
      fill: t.muted,
      anchor: "end",
    }),
  );
  parts.push(rule(PAD, 76, W - PAD, t.hairline));

  cells.forEach(([value, l1, l2], i) => {
    const x = (PAD + i * step).toFixed(1);
    if (i > 0) {
      parts.push(
        `  <line x1="${x}" y1="96" x2="${x}" y2="176" stroke="${t.hairline}" stroke-width="1"/>`,
      );
    }
    parts.push(
      text(x, 138, value, { size: 36, ls: 0.5, fill: t.accent, weight: 600 }),
    );
    parts.push(text(x, 160, l1, { size: 11.5, ls: 1.8, fill: t.muted }));
    parts.push(text(x, 177, l2, { size: 11.5, ls: 1.8, fill: t.muted }));
  });

  parts.push(rule(PAD, 190, W - PAD, t.hairline));
  parts.push(
    text(
      PAD,
      212,
      "MEASURED FROM PUBLIC REPOSITORIES · PRIVATE WORK NOT COUNTED",
      {
        size: 11,
        ls: 1.9,
        fill: t.muted,
      },
    ),
  );
  parts.push(
    text(W - PAD, 212, "RENDERED IN THIS REPOSITORY · UPDATED DAILY", {
      size: 11,
      ls: 1.9,
      fill: t.muted,
      anchor: "end",
    }),
  );

  return doc(
    W,
    H,
    `Public GitHub activity for ${data.user}`,
    cells.map(([v, a, b]) => `${v} ${a} ${b}`.toLowerCase()).join(", ") +
      ". Measured from public repositories only, so private work is not counted.",
    parts.join("\n"),
  );
}

/* ------------------------------------------------------------- language card */

const COLS = 4;

function renderLanguages(data, t) {
  const { total, rows } = selectLanguages(data);
  const gridRows = Math.ceil(rows.length / COLS);
  const H = 122 + gridRows * 34 + 52;

  const parts = [frame(W, H, t)];
  parts.push(
    text(PAD, 54, "LANGUAGES", {
      size: 13,
      ls: 3.4,
      fill: t.accent,
      weight: 600,
    }),
  );
  parts.push(
    text(
      W - PAD,
      54,
      `${rows.length} LANGUAGES · ${size(total)} · ${data.repos} REPOSITORIES`,
      {
        size: 11,
        ls: 2.2,
        fill: t.muted,
        anchor: "end",
      },
    ),
  );
  parts.push(rule(PAD, 76, W - PAD, t.hairline));

  // Proportion bar. One rect per language in rank order, separated by a hairline
  // in the ground colour so adjacent steps of the ramp stay distinguishable.
  const barY = 94;
  const barH = 20;
  let x = PAD;
  rows.forEach((r, i) => {
    const w = INNER * r.share;
    parts.push(
      `  <rect x="${x.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="${barH}" fill="${ramp(t, i, rows.length)}"/>`,
    );
    if (i > 0) {
      parts.push(
        `  <line x1="${x.toFixed(2)}" y1="${barY}" x2="${x.toFixed(2)}" y2="${barY + barH}" stroke="${t.bg}" stroke-width="1"/>`,
      );
    }
    x += w;
  });

  // Legend. Share is right-aligned to the column so no text needs measuring.
  const colW = INNER / COLS;
  rows.forEach((r, i) => {
    const cx = PAD + (i % COLS) * colW;
    const cy = 156 + Math.floor(i / COLS) * 34;
    parts.push(
      `  <rect x="${cx.toFixed(1)}" y="${cy - 9}" width="9" height="9" fill="${ramp(t, i, rows.length)}"/>`,
    );
    parts.push(
      text((cx + 19).toFixed(1), cy, r.name.toUpperCase(), {
        size: 11.5,
        ls: 1.6,
        fill: t.ink,
      }),
    );
    parts.push(
      text((cx + colW - 24).toFixed(1), cy, `${(r.share * 100).toFixed(1)}%`, {
        size: 11.5,
        ls: 1.2,
        fill: t.muted,
        anchor: "end",
      }),
    );
  });

  parts.push(rule(PAD, H - 34, W - PAD, t.hairline));
  parts.push(
    text(
      PAD,
      H - 14,
      "MEASURED IN BYTES BY GITHUB LINGUIST · A LANGUAGE EARNS A ROW BY VOLUME OR BY APPEARING IN TWO OR MORE REPOSITORIES",
      { size: 11, ls: 1.9, fill: t.muted },
    ),
  );

  return doc(
    W,
    H,
    `Languages across ${data.repos} public repositories`,
    rows
      .map((r) => `${r.name} ${(r.share * 100).toFixed(1)} percent`)
      .join(", ") + `. Measured in bytes across ${size(total)} of source.`,
    parts.join("\n"),
  );
}

/* --------------------------------------------------------------- link badges
 *
 * shields.io would have been fewer lines, and it is the same bet the stats
 * service already lost: a third-party host in the render path of a page that has
 * to work. These are drawn here instead, so the palette is defined once.
 *
 * They carry NO background rect, because a #0D0B08 ground on GitHub's #0d1117
 * page reads as a misaligned patch at badge size. The full-width cards keep
 * their ground because at that size it reads as a panel, which is what the
 * header already does.
 *
 * The LinkedIn mark is simple-icons (CC0-1.0), recoloured and scaled. The globe
 * and document glyphs are drawn here at the header's hairline weight.
 */
const GLYPHS = {
  site: (c) =>
    `    <circle cx="8" cy="8" r="7" fill="none" stroke="${c}" stroke-width="1.4"/>\n` +
    `    <ellipse cx="8" cy="8" rx="3.1" ry="7" fill="none" stroke="${c}" stroke-width="1.4"/>\n` +
    `    <line x1="1.2" y1="5.4" x2="14.8" y2="5.4" stroke="${c}" stroke-width="1.4"/>\n` +
    `    <line x1="1.2" y1="10.6" x2="14.8" y2="10.6" stroke="${c}" stroke-width="1.4"/>`,
  linkedin: (c) =>
    `    <path transform="scale(0.6667)" fill="${c}" d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>`,
  doc: (c) =>
    `    <path d="M2.6 0.9 h6.6 l3.9 3.9 v10.3 h-10.5 z" fill="none" stroke="${c}" stroke-width="1.4"/>\n` +
    `    <path d="M9.2 0.9 v3.9 h3.9" fill="none" stroke="${c}" stroke-width="1.4"/>\n` +
    `    <line x1="5" y1="8.4" x2="10.6" y2="8.4" stroke="${c}" stroke-width="1.4"/>\n` +
    `    <line x1="5" y1="11.6" x2="10.6" y2="11.6" stroke="${c}" stroke-width="1.4"/>`,
};

// Monospace advance at 11px with 2.0 letter-spacing. Deliberately a slight
// overestimate: it costs a couple of pixels of trailing padding and can never
// clip a label, which is the failure that would actually be visible.
const LABEL_ADVANCE = 11 * 0.601 + 2.0;

function renderBadge({ glyph, label }, t) {
  const H = 34;
  const padX = 13;
  const gap = 11;
  const w = Math.round(padX * 2 + 16 + gap + label.length * LABEL_ADVANCE);

  const body = [
    `  <rect x="0.6" y="0.6" width="${(w - 1.2).toFixed(1)}" height="${H - 1.2}" fill="none" stroke="${t.hairline}" stroke-width="1.2"/>`,
    `  <line x1="1.2" y1="0.6" x2="1.2" y2="${H - 0.6}" stroke="${t.accent}" stroke-width="2.4"/>`,
    `  <g transform="translate(${padX}, ${(H - 16) / 2})">`,
    GLYPHS[glyph](t.accent),
    `  </g>`,
    text(padX + 16 + gap, 22, label, { size: 11, ls: 2.0, fill: t.ink }),
  ].join("\n");

  return doc(w, H, label, `Link to ${label}`, body);
}

const BADGES = [
  { file: "link-site", glyph: "site", label: "YASHSHELAR.COM" },
  { file: "link-linkedin", glyph: "linkedin", label: "LINKEDIN" },
  { file: "link-resume", glyph: "doc", label: "RÉSUMÉ · PDF" },
];

/* ---------------------------------------------------------------------- main */

// Both sources are fetched before anything is written, so a failure in either
// leaves every committed file as it was.
const [data, claude] = await Promise.all([collect(), collectClaude()]);
const selected = selectLanguages(data);

if (PRINT_JSON) {
  console.log(
    JSON.stringify(
      { ...data, languageTotal: selected.total, selected: selected.rows },
      null,
      2,
    ),
  );
}

await mkdir(OUT, { recursive: true });

const files = [];
for (const [name, theme] of Object.entries(THEMES)) {
  files.push([`header-${name}.svg`, renderHeader(claude, theme)]);
  files.push([`stats-${name}.svg`, renderStats(data, theme)]);
  files.push([`languages-${name}.svg`, renderLanguages(data, theme)]);
  for (const b of BADGES)
    files.push([`${b.file}-${name}.svg`, renderBadge(b, theme)]);
}

for (const [name, svg] of files) await writeFile(join(OUT, name), svg, "utf8");

console.error(
  `wrote ${files.length} files to ${OUT}/\n` +
    `  stars ${data.stars} | commits ${data.commits} | prs ${data.prs} (${data.merged} merged) | ` +
    `issues ${data.issues} | repos ${data.repos} | languages ${selected.rows.length} of ${Object.keys(data.languages).length}\n` +
    `  claude ${claude.tokens} tokens | ${claude.sessions} sessions | streak ${claude.streak}`,
);
