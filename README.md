# Claudian Workspace Overlay

**Claudian Workspace Overlay** is an Obsidian companion plugin for Claudian that adds two workflow-oriented layers on top of Claudian without modifying Claudian's core code:

1. **Conversation Search** — search within the currently active Claudian conversation.
2. **Scoped Workspaces** — separate global Claudian slots from per-note Claudian slots, so learning one note does not pollute the context of another.

> This plugin is designed as an external overlay around Claudian. Its goal is to preserve Claudian upgradeability while adding workflow controls for Obsidian-based study and knowledge work.

## Why this exists

Claudian is useful both as a global knowledge-base assistant and as a focused reading companion for a specific Markdown note. In real use, these two modes need different context boundaries:

- **Global workspace**: for vault-wide organization, synthesis, scoring, refactoring, and management tasks.
- **Note workspace**: for focused Q&A while studying a specific Markdown file.

Claudian Workspace Overlay keeps those contexts separate by giving each note its own logical Claudian slots while still sharing a small physical tab pool under the hood.

## Features

### Per-note Claudian slots

Each Markdown note can have up to three logical Claudian slots:

- `N1`
- `N2`
- `N3`

When you leave a note, its physical tabs can be released. When you return, the plugin restores the note's previous conversations.

### Global Claudian slots

The global Claudian workspace also has up to three logical slots:

- `G1`
- `G2`
- `G3`

These are intended for vault-wide or cross-note tasks.

### Physical tab pool reuse

Claudian itself is configured with a physical tab capacity of six. This overlay maps logical slots onto those physical tabs and prefers reusing existing hidden tab shells instead of constantly closing and recreating tabs.

This reduces tab churn and improves high-frequency note switching performance.

### Blank tabs stay flexible

New note slots start as true blank Claudian tabs instead of pre-created conversations. This keeps model/provider selection flexible until the first real message is sent.

### Search overlay

The plugin adds a compact search UI to the Claudian header for searching messages in the active conversation.

### Diagnostics and maintenance commands

The plugin includes commands for debugging and cleanup:

- `Open Claudian search`
- `Open current note Claudian slots`
- `Open global Claudian slots`
- `Compact hidden Claudian tabs`
- `Cleanup empty Claudian note slots`
- `Copy Claudian overlay diagnostics`
- `Show Claudian slot status`

## Design principles

- **No Claudian core patching**: implemented as an external overlay where possible.
- **Context isolation**: global tasks and note-specific study should not pollute each other.
- **Lazy creation**: only create logical slots when needed.
- **Restore what existed**: if a note had one, two, or three conversations, restore that same count.
- **Performance-aware**: reuse physical tabs and provide manual compaction tools.

## Repository note

Do not commit local runtime state such as `data.json`; it contains per-vault slot mappings and conversation ids.
