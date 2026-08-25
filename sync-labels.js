#!/usr/bin/env bun
//
// Pane Topic Sync -- herdr plugin
//
// On each subscribed event, walk every pane in the session and:
//   1. rename each *agent* pane to its live topic (terminal_title_stripped)
//   2. rename each tab to the topic of a chosen pane (see `tab_source`)
//
// Plain (non-agent) shell panes are ignored so a tab never gets named after a
// shell prompt. Writes are gated through a state file so we only call `rename`
// when a label actually changed -- no churn, and (combined with not subscribing
// to *.renamed events) no feedback loop.
//
// Manually renamed panes and tabs are left alone (`respect_manual_names`). See
// `isOwned` for how ownership is decided.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const herdr = process.env.HERDR_BIN_PATH || "herdr";
// herdr sets HERDR_PLUGIN_STATE_DIR; the fallback is only for running this by
// hand. `tmpdir()` rather than "/tmp" so that path is valid on Windows too.
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || tmpdir();
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || "";
const statePath = join(stateDir, "pane-topic-sync-state.json");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULTS = {
  sync_panes: true,             // rename agent panes to their topic
  sync_tabs: true,              // rename tabs to a pane's topic
  tab_source: "first",          // "first" (top-left) | "active" (tab's focused pane)
  max_label_length: 60,         // truncate longer labels with an ellipsis
  tab_format: "{topic}",        // tokens: {topic} {agent} {n} {workspace}
  pane_format: "{topic}",       // tokens: {topic} {agent} {workspace}
  respect_manual_names: true,   // never overwrite a pane/tab you renamed yourself
};

// Minimal flat-TOML reader: key = value, one per line. Values may be quoted
// strings (which may themselves contain '#', '{', etc.), bare booleans, or
// integers. Sufficient for this plugin's flat config; not a general parser.
function parseFlatToml(text) {
  const out = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    out[key] = parseValue(line.slice(eq + 1).trim());
  }
  return out;
}

function parseValue(raw) {
  if (raw[0] === '"' || raw[0] === "'") {
    const end = raw.indexOf(raw[0], 1);
    return end > 0 ? raw.slice(1, end) : raw.slice(1);
  }
  const bare = raw.replace(/\s+#.*$/, "").trim(); // strip trailing comment
  if (bare === "true") return true;
  if (bare === "false") return false;
  if (/^-?\d+$/.test(bare)) return parseInt(bare, 10);
  return bare;
}

function loadConfig() {
  const cfg = { ...DEFAULTS };
  if (configDir) {
    try {
      Object.assign(cfg, parseFlatToml(readFileSync(join(configDir, "config.toml"), "utf8")));
    } catch {
      // no config file -> defaults
    }
  }
  // Validate / coerce.
  cfg.sync_panes = cfg.sync_panes !== false;
  cfg.sync_tabs = cfg.sync_tabs !== false;
  cfg.respect_manual_names = cfg.respect_manual_names !== false;
  if (cfg.tab_source !== "active") cfg.tab_source = "first";
  const n = parseInt(cfg.max_label_length, 10);
  cfg.max_label_length = Number.isFinite(n) && n > 0 ? n : DEFAULTS.max_label_length;
  if (typeof cfg.tab_format !== "string" || !cfg.tab_format) cfg.tab_format = DEFAULTS.tab_format;
  if (typeof cfg.pane_format !== "string" || !cfg.pane_format) cfg.pane_format = DEFAULTS.pane_format;
  return cfg;
}

// ---------------------------------------------------------------------------
// herdr CLI helpers
// ---------------------------------------------------------------------------

function run(args) {
  const r = spawnSync(herdr, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    throw new Error(`${herdr} ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r.stdout.trim();
}

function json(args) {
  const out = run(args);
  return out ? JSON.parse(out) : null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// Normalize a raw topic: drop control chars / spinner / stray markup, collapse
// whitespace. Does NOT truncate -- truncation happens after formatting.
function normalize(value) {
  return String(value ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ")               // control chars
    .replace(/^<command-name>.*?<\/command-name>\s*/i, "")
    .replace(/<[^>]+>/g, " ")                        // stray markup
    .replace(/^[>›⠀-⣿]+\s*/, "")       // leading '>', '›', braille spinner
    .replace(/\s+/g, " ")
    .trim();
}

function cap(str, max) {
  return str.length > max ? `${str.slice(0, max - 1).trimEnd()}…` : str;
}

// Replace {token}s from `tokens`; unknown tokens are left literal.
function applyFormat(fmt, tokens) {
  return fmt.replace(/\{(\w+)\}/g, (m, k) => (k in tokens ? String(tokens[k] ?? "") : m));
}

// ---------------------------------------------------------------------------
// State + ownership
//
// We record the last label we wrote for each pane/tab. On the next run, if the
// live label is no longer that string, a human renamed it in the meantime and
// we stop managing it. State is keyed by pane_id / tab_id; those ids can be
// recycled after a close, but a recycled pane/tab always comes back in its
// "virgin" state below, which is adoptable anyway -- so a stale entry is inert.
// ---------------------------------------------------------------------------

function loadState() {
  try {
    const s = JSON.parse(readFileSync(statePath, "utf8"));
    return { panes: s.panes || {}, tabs: s.tabs || {} };
  } catch {
    return { panes: {}, tabs: {} };
  }
}

// A label is ours to write if any of these hold; anything else is a human's
// name and we leave it alone:
//
//   1. it has never been named by anyone -- its `virgin` default
//   2. its live label is still verbatim what we last wrote
//   3. it already reads exactly what we are about to write (`desired`)
//
// (3) is what makes this self-healing: lose the state file (reinstall, new
// machine) and we re-adopt everything still carrying a label we'd produce,
// instead of freezing because we no longer recognize our own work.
//
// The virgin default differs by kind, per the herdr API:
//   pane -> label is null (PaneInfo.label is nullable; unset until first rename)
//   tab  -> label is its 1-based switch position within the workspace, as a
//           string (TabInfo.label is non-nullable, so herdr seeds it from
//           that compact position instead). This is NOT the same as
//           TabInfo.number, which is a persistent, non-reused id that keeps
//           incrementing and drifts away from the compact position as tabs
//           open, close, and move -- comparing against `number` here made
//           every untouched tab look "manually renamed" once that drift
//           happened, freezing tab sync (panes were unaffected: their virgin
//           default is `null`, not a number).
function isOwned(live, lastWritten, virgin, desired) {
  return live === virgin || live === desired || (lastWritten !== undefined && live === lastWritten);
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const cfg = loadConfig();
  const panes = json(["pane", "list"])?.result?.panes ?? [];
  const tabs = json(["tab", "list"])?.result?.tabs ?? [];

  // paneId -> { topic, agent } for agent panes that have a real topic.
  const info = new Map();
  for (const p of panes) {
    if (!p.agent) continue;
    const topic = normalize(p.terminal_title_stripped);
    if (topic) info.set(p.pane_id, { topic, agent: p.agent });
  }

  // Group panes by tab (list order).
  const byTab = new Map();
  for (const p of panes) {
    if (!byTab.has(p.tab_id)) byTab.set(p.tab_id, []);
    byTab.get(p.tab_id).push(p);
  }

  // Lazy workspace-label lookup (only if a format references {workspace}).
  const needWs = /\{workspace\}/.test(cfg.tab_format) || /\{workspace\}/.test(cfg.pane_format);
  const wsCache = new Map();
  const wsLabel = (id) => {
    if (!needWs || !id) return "";
    if (!wsCache.has(id)) {
      let label = "";
      try { label = normalize(json(["workspace", "get", id])?.result?.workspace?.label); } catch {}
      wsCache.set(id, label);
    }
    return wsCache.get(id);
  };

  let paneWrites = 0;
  let tabWrites = 0;
  let paneSkips = 0;
  let tabSkips = 0;
  const state = loadState();
  const nextPanes = {};
  const nextTabs = {};

  // 1) Panes.
  if (cfg.sync_panes) {
    for (const p of panes) {
      const meta = info.get(p.pane_id);
      if (!meta) continue;
      const label = cap(
        applyFormat(cfg.pane_format, { topic: meta.topic, agent: meta.agent, workspace: wsLabel(p.workspace_id) }),
        cfg.max_label_length,
      );
      // `pane list` omits `label` entirely when unset; normalize that to null.
      const live = p.label ?? null;
      if (cfg.respect_manual_names && !isOwned(live, state.panes[p.pane_id], null, label)) {
        // Renamed by hand. Drop our state entry too, so the only way back under
        // management is `herdr pane rename <id> --clear` (-> null -> virgin).
        paneSkips++;
        continue;
      }
      nextPanes[p.pane_id] = label;
      if (live !== label) {
        run(["pane", "rename", p.pane_id, label]);
        paneWrites++;
      }
    }
  } else {
    // Preserve prior state so toggling sync_panes back on doesn't re-churn.
    Object.assign(nextPanes, state.panes);
  }

  // 2) Tabs. Tab switch number = 1-based position within its workspace.
  const orderInWs = new Map();
  const wsCounters = new Map();
  for (const t of tabs) {
    const c = (wsCounters.get(t.workspace_id) || 0) + 1;
    wsCounters.set(t.workspace_id, c);
    orderInWs.set(t.tab_id, c);
  }

  if (cfg.sync_tabs) {
    const tabById = new Map(tabs.map((t) => [t.tab_id, t]));
    for (const [tabId, tabPanes] of byTab) {
      const tab = tabById.get(tabId);
      if (!tab) continue;
      const srcId = sourcePaneId(tabPanes, cfg.tab_source);
      // Chosen pane's topic; fall back to first agent pane in list order.
      let meta = info.get(srcId);
      if (!meta) {
        for (const p of tabPanes) {
          if (info.has(p.pane_id)) { meta = info.get(p.pane_id); break; }
        }
      }
      if (!meta) continue;
      const wsId = tabPanes[0].workspace_id;
      const labelFor = (m) => cap(
        applyFormat(cfg.tab_format, {
          topic: m.topic,
          agent: m.agent,
          n: orderInWs.get(tabId) ?? "",
          workspace: wsLabel(wsId),
        }),
        cfg.max_label_length,
      );
      const label = labelFor(meta);
      // Which pane names a tab can change between runs -- `tab_source =
      // "active"` follows your focus, and panes come and go. So for the
      // self-heal check, count a label we'd write for *any* agent pane in this
      // tab as ours, not just the one currently chosen.
      const plausiblyOurs = tabPanes.some((p) => {
        const m = info.get(p.pane_id);
        return m !== undefined && tab.label === labelFor(m);
      });
      const virgin = String(orderInWs.get(tabId));
      const owned = plausiblyOurs || isOwned(tab.label, state.tabs[tabId], virgin, label);
      if (cfg.respect_manual_names && !owned) {
        // Renamed by hand. Drop our state entry too, so the way back under
        // management is to rename it to its current compact switch position
        // (its virgin default -- see the isOwned comment above).
        tabSkips++;
        continue;
      }
      nextTabs[tabId] = label;
      if (tab.label !== label) {
        run(["tab", "rename", tabId, label]);
        tabWrites++;
      }
    }
  } else {
    // Preserve prior state so toggling sync_tabs back on doesn't re-churn.
    Object.assign(nextTabs, state.tabs);
  }

  saveState({ panes: nextPanes, tabs: nextTabs });
  const skipped = cfg.respect_manual_names ? `, kept ${paneSkips} pane / ${tabSkips} tab manual name(s)` : "";
  console.log(
    `synced: ${paneWrites} pane rename(s), ${tabWrites} tab rename(s)${skipped} ` +
    `[panes=${cfg.sync_panes} tabs=${cfg.sync_tabs} source=${cfg.tab_source} manual=${cfg.respect_manual_names}]`,
  );
}

// Which pane's topic represents a tab, per config.
//   "active" -> the tab's own focused pane (herdr tracks this per tab)
//   "first"  -> top-left pane in reading order
function sourcePaneId(tabPanes, source) {
  if (tabPanes.length === 1) return tabPanes[0].pane_id;
  let layout;
  try { layout = json(["pane", "layout", "--pane", tabPanes[0].pane_id])?.result?.layout; } catch {}
  if (!layout?.panes?.length) return tabPanes[0].pane_id;
  if (source === "active" && layout.focused_pane_id) return layout.focused_pane_id;
  const sorted = [...layout.panes].sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
  return sorted[0].pane_id;
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
