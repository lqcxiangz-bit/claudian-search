# Claudian Search

Search and jump within the current Claudian conversation in Obsidian.

## Features

- Floating search button inside the Claudian header.
- Searches the currently active Claudian conversation.
- Works across supported Claudian providers when messages are loaded in the current tab.
- Highlights matched terms in the result preview.
- Jumps to the matching message in the current conversation.
- Ranks results by match relevance.

## Requirements

- Obsidian desktop.
- The Claudian Obsidian plugin installed and enabled.

## Installation

1. Download this repository.
2. Copy the repository folder to:

   ```text
   <your-vault>/.obsidian/plugins/claudian-search/
   ```

3. Restart Obsidian or reload community plugins.
4. Enable **Claudian Search** in Obsidian settings.

## Notes

This is a companion plugin for Claudian. It relies on Claudian's current UI and runtime state, so future Claudian updates may require compatibility fixes.

The plugin is desktop-only because it reads local Claudian/Codex fallback history from the vault when current runtime messages are unavailable.
