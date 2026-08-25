# Pane Topic Sync

A [herdr](https://herdr.dev) plugin that auto-names your panes and tabs after
what each agent is actually working on — no more tabs labeled `1`, `2`, `3`.

On every relevant herdr event it:

1. **Renames each agent pane** to its live topic — the `terminal_title_stripped`
   that Claude Code (and other agents) emit via the terminal title. With
   `show_agent_labels_on_pane_borders = true` in your herdr config, that topic
   shows right on the pane border.
2. **Renames each tab** to the topic of its **first pane** (top-left, reading
   order). If the first pane is a plain shell, the first *agent* pane's topic is
   used instead, so a tab is never named after a shell prompt.

Plain (non-agent) shell panes are left untouched.

## How it works

- Subscribes to `pane.*` / `tab.focused` / `workspace.focused` events (see
  `herdr-plugin.toml`). The key trigger is `pane.agent_status_changed`, which
  fires when an agent flips idle↔working — i.e. when it sets a fresh topic.
- Deliberately does **not** subscribe to `*.renamed` events, so its own renames
  can't feed back into a loop.
- Gates all writes through a state file (`$HERDR_PLUGIN_STATE_DIR/pane-topic-sync-state.json`),
  so `rename` is only called when a topic actually changed — no churn. The same
  file records which labels are the plugin's own, so manual renames survive (see
  [Manual renames are respected](#manual-renames-are-respected)).
- "First pane" is resolved from `herdr pane layout` rect coordinates, sorted by
  `(y, x)`, so it's the visually top-left pane regardless of split order.

## Install

Local (development):

```sh
git clone <this-repo> ~/repos/herdr-pane-topic-sync
herdr plugin link ~/repos/herdr-pane-topic-sync
herdr server reload-config
```

Requires [bun](https://bun.sh) on `PATH` (herdr runs `bun sync-labels.js`).

Runs on macOS, Linux, and Windows — the script only uses cross-platform stdlib
and shells out to the `herdr` CLI itself.

To see topics on pane borders too, add to `~/.config/herdr/config.toml`:

```toml
[ui]
show_agent_labels_on_pane_borders = true
```

## Manual sync / debugging

```sh
herdr plugin action invoke dan.pane-topic-sync.sync
herdr plugin log list --plugin dan.pane-topic-sync --limit 5
```

## Configuration

Optional. Drop a `config.toml` in the plugin's config dir (find it with
`herdr plugin config-dir dan.pane-topic-sync`). All keys are optional; see
[`examples/default-config.toml`](examples/default-config.toml) for the full
documented set. Summary:

| Key | Default | Meaning |
|-----|---------|---------|
| `sync_panes` | `true` | Rename agent panes to their topic. |
| `sync_tabs` | `true` | Rename tabs. |
| `tab_source` | `"first"` | Which pane names a multi-pane tab: `"first"` (top-left) or `"active"` (the pane you last focused *within that tab* — herdr tracks this per tab). |
| `max_label_length` | `60` | Truncate longer labels (applied after formatting). |
| `tab_format` | `"{topic}"` | Template; tokens `{topic}` `{agent}` `{workspace}` `{n}` (tab switch number). |
| `pane_format` | `"{topic}"` | Template; tokens `{topic}` `{agent}` `{workspace}`. |
| `respect_manual_names` | `true` | Never overwrite a pane/tab you renamed yourself. See below. |

Examples: `tab_format = "{n}· {topic}"` keeps the tab switch number;
`pane_format = "{agent}: {topic}"` prefixes the agent name.

### Manual renames are respected

Rename a pane or tab yourself and the plugin backs off it permanently — no
special characters or marker prefixes in your labels. herdr exposes no
provenance for a label, so ownership is inferred from three signals:

1. **Never named.** A pane's label is `null` until something names it; a tab's
   label defaults to its 1-based switch position within its workspace (`"2"`),
   which herdr keeps compact as tabs open, close, and move — it is not the
   same as the tab's persistent `number`. Either state is unclaimed, so the
   plugin adopts it.
2. **Still ours.** The live label is verbatim what the plugin last wrote (from
   the state file). If it differs, you changed it — hands off.
3. **Reads like ours.** The live label is exactly what the plugin *would* write
   right now, for any agent pane in that tab. This makes the plugin self-healing:
   delete the state file and it re-adopts everything it recognizes instead of
   freezing, while still leaving your manual names alone.

To hand a name back to the plugin, return it to its unclaimed state:

```sh
herdr pane rename <pane_id> --clear         # panes: clears the label
herdr tab rename <tab_id> <switch-position> # tabs: rename to its current switch position
```

Check a tab's current switch position with `herdr tab get <tab_id>` (the
`label` field already shows it if the tab is still unclaimed) before renaming
back to it.

Set `respect_manual_names = false` for the old always-overwrite behavior.

Caveat: renaming a tab to a plain number is indistinguishable from a tab nobody
has named, so the plugin will claim it.

## License

MIT
