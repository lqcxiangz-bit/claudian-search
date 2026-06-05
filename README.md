# Claudian Workspace Overlay

> English | [中文](#中文)

**Claudian Workspace Overlay** is a lightweight Obsidian companion plugin for [Claudian](https://github.com/lqcxiangz-bit/claudian). It adds a workspace layer outside Claudian itself, so you can keep Claudian upgradeable while gaining two workflow features that matter in long-term note work:

1. **Search the current Claudian session** — quickly find earlier messages inside the active Claudian conversation.
2. **Article-level Claudian entry points** — when you open a Markdown note, the plugin can restore that note's own Claudian context automatically, so you do not have to manually hunt for the right historical session.

The plugin is intentionally implemented as an **external overlay**. It does not patch or fork Claudian's core code, which keeps Claudian easier to update.

## Why this exists

Claudian is useful in two different modes:

- **Global assistant mode**: vault-wide organization, synthesis, scoring, refactoring, workflow management, and cross-note thinking.
- **Article / note companion mode**: focused reading, Q&A, explanation, and continuation around one specific Markdown note.

Without an extra workspace layer, these two modes can blur together. A question about one article may pollute the context of another article, and an old useful conversation may be hard to find again.

Claudian Workspace Overlay solves this by adding a small routing layer around Claudian:

- Global work keeps its own global Claudian slots.
- Each Markdown note can keep its own note-scoped Claudian slots.
- Returning to a note restores the conversations that belong to that note.
- The active conversation can be searched from a compact overlay UI.

## Core features

### 1. Current-session conversation search

Adds a compact search panel to the Claudian header. It indexes the active Claudian conversation and lets you search earlier turns without leaving the current workspace.

Use it when you remember that “we discussed this before” but do not want to scroll through a long session manually.

### 2. Article-level Claudian entry

Adds note-level Claudian controls for Markdown files. Each note can reopen its own Claudian workspace, making the note itself the entry point for its related AI context.

This is designed for article reading, source analysis, long notes, and study workflows where the useful context belongs to the note, not to a global chat list.

### 3. Scoped global and note workspaces

The overlay separates two kinds of logical slots:

- **Global slots**: `G1`, `G2`, `G3`
- **Current-note slots**: `N1`, `N2`, `N3`

Global slots are for vault-wide or cross-note work. Note slots are for the currently active Markdown note.

### 4. Automatic note context restoration

When you switch away from a note, the overlay can release its physical Claudian tabs. When you come back, it restores the note's previous conversations by using the saved note-to-session mapping.

This makes each article feel like it has its own persistent Claudian context.

### 5. Physical tab-pool reuse

Claudian is configured with a small physical tab pool. The overlay maps many logical note/global slots onto that physical pool and prefers reusing existing hidden tab shells instead of constantly closing and recreating tabs.

This reduces tab churn and keeps frequent note switching smoother.

### 6. Flexible blank slots

New note slots start as real blank Claudian tabs rather than pre-created conversations. Model/provider selection stays flexible until you send the first message.

### 7. Diagnostics and cleanup commands

The plugin includes maintenance commands for inspecting and cleaning workspace state:

- `Open Claudian search`
- `Open current note Claudian slots`
- `Open global Claudian slots`
- `Compact hidden Claudian tabs`
- `Cleanup empty Claudian note slots`
- `Copy Claudian overlay diagnostics`
- `Show Claudian slot status`

## Design principles

- **External overlay, not core modification**: keep Claudian upgradeable.
- **Context belongs where the work happens**: article-level work should reopen from the article itself.
- **Global and note contexts should not pollute each other**.
- **Lazy creation**: create conversations only when they are actually used.
- **Restore what existed**: if a note had one, two, or three conversations, restore that same workspace shape.
- **Performance-aware**: reuse physical tabs and provide manual compaction tools.


## Release notes

### 0.2.1

- Fix compatibility with newer Claudian builds whose plugin id is `realclaudian` while retaining fallback support for the legacy `claudian` id.
- Route overlay view opening, conversation lookup, and history restoration through a single core-plugin resolver to avoid scoped tab/conversation mismatches after Claudian updates.

## Installation

This is an Obsidian desktop plugin intended to be installed manually during development or personal use.

1. Install and enable Claudian first.
2. Create a plugin folder in your vault:

   ```text
   <your-vault>/.obsidian/plugins/claudian-search-overlay/
   ```

3. Copy these files into that folder:

   ```text
   manifest.json
   main.js
   styles.css
   ```

4. Restart Obsidian or reload plugins.
5. Enable **Claudian Workspace Overlay** in Obsidian's Community Plugins settings.

## Usage

### Search the active Claudian conversation

Run the command:

```text
Open Claudian search
```

Or use the search control injected into the Claudian header when available.

### Open the current note's Claudian workspace

Open a Markdown note, then run:

```text
Open current note Claudian slots
```

The overlay opens/restores the note-scoped Claudian slots for that file.

### Open the global Claudian workspace

Run:

```text
Open global Claudian slots
```

Use this for vault-wide thinking and cross-note tasks.

## Runtime state

The plugin stores local runtime mappings such as note paths, logical slots, physical tab ids, and Claudian conversation ids in plugin data.

Do **not** commit local runtime state such as `data.json`. It is vault-specific and may contain private workflow/session information.

## Relationship to Claudian

This plugin is a companion layer for Claudian. It assumes Claudian is installed, but it is designed to live outside Claudian's main codebase.

That separation is the point: Claudian can keep evolving, and this overlay can carry personal workflow behavior without making Claudian core harder to upgrade.

---

## 中文

# Claudian Workspace Overlay

**Claudian Workspace Overlay** 是一个给 [Claudian](https://github.com/lqcxiangz-bit/claudian) 使用的 Obsidian 伴随插件。它不是修改 Claudian 主体，而是在 Claudian 外面加一层工作区外挂，让 Claudian 保持可升级，同时补上两个长期知识工作里很关键的能力：

1. **搜索当前 Claudian session 的历史对话** —— 在当前 Claudian 对话里快速找回前面说过的内容。
2. **文章级 Claudian 入口** —— 每篇 Markdown 文章都可以拥有自己的 Claudian 上下文；再次打开文章时，自动恢复这篇文章对应的上下文 session，不用再去历史记录里手动找。

这个插件的定位是 **Claudian 外挂层 / overlay**。它尽量不 patch、不 fork Claudian 的核心代码，所以不会影响 Claudian 主体后续升级。

## 为什么需要这个插件

Claudian 在 Obsidian 里通常会有两种用法：

- **全局助手模式**：整理整个 vault、做跨笔记总结、评分、重构、工作流管理、知识库级分析。
- **文章 / 笔记陪读模式**：围绕某一篇 Markdown 做阅读、问答、解释、追问和上下文延续。

这两种模式需要不同的上下文边界。如果都混在同一个全局对话列表里，就会出现两个问题：

- 一篇文章的讨论污染另一篇文章的上下文。
- 之后想继续某篇文章的旧对话时，很难从历史 session 里找回正确的那一个。

Claudian Workspace Overlay 通过在 Claudian 外面加一层工作区映射来解决这个问题：

- 全局任务使用全局 Claudian 槽位。
- 每篇 Markdown 笔记拥有自己的文章级 Claudian 槽位。
- 回到某篇笔记时，自动恢复这篇笔记之前绑定的对话。
- 当前对话可以通过轻量搜索面板直接检索。

## 核心功能

### 1. 当前 session 对话搜索

插件会在 Claudian 顶部加入一个轻量搜索面板，用来索引并搜索当前激活的 Claudian 对话。

适合这种场景：你记得“前面讨论过这个”，但不想在很长的对话里手动滚动查找。

### 2. 文章级 Claudian 入口

插件会给 Markdown 笔记增加文章级 Claudian 控制入口。每篇笔记都可以重新打开自己的 Claudian 工作区，让“文章本身”成为进入相关 AI 上下文的入口。

这个设计特别适合文章阅读、资料分析、长笔记学习、逐篇研究等场景：有用的上下文应该跟着文章走，而不是散落在全局聊天历史里。

### 3. 全局 / 当前文章上下文隔离

Overlay 把 Claudian 槽位分成两类：

- **全局槽位**：`G1`、`G2`、`G3`
- **当前文章槽位**：`N1`、`N2`、`N3`

全局槽位适合跨笔记、全库级任务；文章槽位只服务当前打开的 Markdown 笔记。

### 4. 自动恢复文章上下文

当你离开一篇笔记时，插件可以释放对应的物理 Claudian 标签页；当你再次回到这篇笔记时，插件会根据保存的“笔记 → session”映射恢复之前的对话。

这样每篇文章都像拥有自己的长期 Claudian 上下文。

### 5. 物理标签页池复用

Claudian 实际只需要维持一个较小的物理标签页池。Overlay 会把大量逻辑上的文章 / 全局槽位映射到这个物理池上，并优先复用隐藏标签页，而不是频繁关闭和重建。

这样可以减少标签页抖动，让高频切换文章时更顺滑。

### 6. 空白槽位保持灵活

新的文章槽位会先保持为真正的 Claudian 空白标签页，而不是提前创建对话。只有当你发送第一条消息时，才真正形成 session，因此模型和 provider 的选择仍然保持灵活。

### 7. 诊断与清理命令

插件提供了一组维护命令，用于查看和清理工作区状态：

- `Open Claudian search`
- `Open current note Claudian slots`
- `Open global Claudian slots`
- `Compact hidden Claudian tabs`
- `Cleanup empty Claudian note slots`
- `Copy Claudian overlay diagnostics`
- `Show Claudian slot status`

## 设计原则

- **外挂层，不改核心**：保持 Claudian 主体可升级。
- **上下文跟着工作对象走**：文章级工作应该能从文章本身重新进入。
- **全局上下文和文章上下文互不污染**。
- **懒创建**：只有真正使用时才创建对话。
- **恢复原样**：一篇文章之前有 1 个、2 个还是 3 个对话，就恢复相同数量和形态。
- **重视性能**：复用物理标签页，并提供手动压缩清理工具。

## 安装方式

这是一个面向 Obsidian 桌面端的插件，当前适合手动安装 / 个人使用。

1. 先安装并启用 Claudian。
2. 在 vault 中创建插件目录：

   ```text
   <your-vault>/.obsidian/plugins/claudian-search-overlay/
   ```

3. 把以下文件复制进去：

   ```text
   manifest.json
   main.js
   styles.css
   ```

4. 重启 Obsidian，或重新加载插件。
5. 在 Obsidian 的第三方插件设置中启用 **Claudian Workspace Overlay**。


## 版本说明

### 0.2.1

- 修复新版 Claudian 核心插件 id 为 `realclaudian` 时，overlay 仍查找旧 `claudian` id 导致的窗口 / 会话绑定错位。
- 将打开 Claudian view、读取当前 conversation、恢复历史会话等路径统一到核心插件解析器，并保留旧 id fallback。

## 使用方式

### 搜索当前 Claudian 对话

运行命令：

```text
Open Claudian search
```

也可以使用插件注入到 Claudian 顶部的搜索入口。

### 打开当前文章的 Claudian 工作区

打开一篇 Markdown 笔记，然后运行：

```text
Open current note Claudian slots
```

插件会打开 / 恢复这篇文章自己的 Claudian 槽位。

### 打开全局 Claudian 工作区

运行命令：

```text
Open global Claudian slots
```

适合用于全库整理、跨笔记总结和工作流级任务。

## 运行状态数据

插件会在本地保存笔记路径、逻辑槽位、物理标签页 id、Claudian conversation id 等映射信息。

不要提交 `data.json` 这类本地运行状态文件。它是 vault 相关的，也可能包含私人工作流或 session 信息。

## 和 Claudian 的关系

这个插件是 Claudian 的伴随外挂层。它依赖 Claudian 已安装，但设计上尽量独立于 Claudian 主仓库。

这种分离正是它的价值：Claudian 主体可以继续升级，而个人工作流层可以留在 overlay 中，不把 Claudian 核心改得难以维护。
