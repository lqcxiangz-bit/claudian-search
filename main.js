const { Plugin, Notice, setIcon } = require("obsidian");
const fs = require("fs");
const path = require("path");

const VIEW_TYPE_CLAUDIAN = "claudian-view";
const PLUGIN_ID_CLAUDIAN = "realclaudian";
const LEGACY_PLUGIN_ID_CLAUDIAN = "claudian";
const SESSIONS_DIR = ".claudian/sessions";
const MAX_RESULTS = 40;
const HIGHLIGHT_CLASS = "claudian-search-overlay__target";
const NOTE_ENTRY_DATA_KEY = "noteEntry";
const NOTE_ENTRY_TARGET_MAX_TABS = 6;
const NOTE_ENTRY_GLOBAL_SLOT_COUNT = 3;
const NOTE_ENTRY_NOTE_SLOT_COUNT = 3;
const NOTE_ENTRY_VIEW_TYPE_MARKDOWN = "markdown";
const NOTE_ENTRY_SCOPE_GLOBAL = "global";
const NOTE_ENTRY_SCOPE_NOTE = "note";

module.exports = class ClaudianSearchOverlayPlugin extends Plugin {
  async onload() {
    this.index = [];
    this.indexBuiltAt = 0;
    this.activePanels = new Map();
    this.searchTimer = null;
    this.scanTimer = null;
    this.scopeTimer = null;
    this.noteActionTimer = null;
    this.maxTabsTimer = null;
    this.styleEl = null;
    this.toastEl = null;
    this.noteEntryState = { notes: {}, globalTabIds: [], lastNotePath: "" };
    this.noteActions = new WeakMap();
    this.noteActionEls = new Set();
    this.noteControls = new Map();
    this.activeNoteScope = null;
    this.patchedTabManagers = new Set();
    this.patchedTabBars = new Set();
    this.patchedViews = new Set();
    this.bypassScopedTabLimit = false;
    this.bypassScopedConversationRemember = false;

    await this.loadNoteEntryState();
    await this.ensureClaudianMaxTabs();

    this.injectRuntimeStyles();

    this.addCommand({
      id: "open-search",
      name: "Open Claudian search",
      callback: async () => {
        await this.ensureIndex();
        const view = await this.ensureClaudianView();
        this.injectIntoView(view);
        const panel = this.getPanelForView(view);
        if (panel) this.openPanel(panel);
      }
    });

    this.addCommand({
      id: "open-note-claudian-slots",
      name: "Open current note Claudian slots",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") {
          new Notice("No active Markdown note.");
          return;
        }
        await this.openNoteClaudianForFile(file, 0);
      }
    });

    this.addCommand({
      id: "open-global-claudian-slots",
      name: "Open global Claudian slots",
      callback: async () => {
        const view = await this.ensureClaudianView();
        await this.activateGlobalSlot(view, 0);
      }
    });

    this.addCommand({
      id: "compact-hidden-tabs",
      name: "Compact hidden Claudian tabs",
      callback: async () => {
        const view = await this.ensureClaudianView();
        const report = await this.compactHiddenTabs(view);
        new Notice(`已压缩隐藏窗口：关闭 ${report.closedTabs} 个，清理空槽 ${report.removedEmptySlots} 个，当前物理窗口 ${report.physicalTabsAfter} 个。`);
      }
    });

    this.addCommand({
      id: "cleanup-empty-note-slots",
      name: "Cleanup empty Claudian note slots",
      callback: async () => {
        const report = await this.cleanupEmptyNoteSlots();
        new Notice(`已清理空文档槽：${report.removedEmptySlots} 个；涉及文章 ${report.touchedNotes} 篇。`);
      }
    });

    this.addCommand({
      id: "copy-diagnostics",
      name: "Copy Claudian overlay diagnostics",
      callback: async () => {
        const view = await this.ensureClaudianView();
        const diagnostics = this.collectDiagnostics(view);
        await this.copyText(JSON.stringify(diagnostics, null, 2));
        new Notice("Claudian Overlay diagnostics 已复制到剪贴板。");
      }
    });

    this.addCommand({
      id: "show-slot-status",
      name: "Show Claudian slot status",
      callback: async () => {
        const view = await this.ensureClaudianView();
        const status = this.formatSlotStatus(this.collectDiagnostics(view));
        await this.copyText(status);
        new Notice("Claudian 窗口状态已复制到剪贴板。");
      }
    });

    this.observer = new MutationObserver(() => {
      this.scheduleScan();
      this.scheduleNoteActionScan();
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.register(() => this.observer.disconnect());

    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.scheduleScan();
      this.scheduleNoteActionScan();
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.scheduleScan();
      this.scheduleNoteActionScan();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleNoteActionScan()));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleNoteRenamed(file, oldPath)));

    this.scopeTimer = window.setInterval(() => this.refreshPanelsForScopeChange(), 600);
    this.register(() => this.scopeTimer && window.clearInterval(this.scopeTimer));

    this.maxTabsTimer = window.setInterval(() => this.ensureClaudianMaxTabs(), 5000);
    this.register(() => this.maxTabsTimer && window.clearInterval(this.maxTabsTimer));

    this.scheduleScan();
    this.scheduleNoteActionScan();
  }

  onunload() {
    if (this.scanTimer) window.clearTimeout(this.scanTimer);
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    if (this.scopeTimer) window.clearInterval(this.scopeTimer);
    if (this.noteActionTimer) window.clearTimeout(this.noteActionTimer);
    if (this.maxTabsTimer) window.clearInterval(this.maxTabsTimer);
    if (this.styleEl) this.styleEl.remove();
    if (this.toastEl) this.toastEl.remove();
    for (const panel of this.activePanels.values()) {
      panel.root.remove();
      if (panel.toolbar) panel.toolbar.remove();
      if (panel.toolbarBg) panel.toolbarBg.remove();
    }
    this.activePanels.clear();
    for (const actionEl of this.noteActionEls) actionEl.remove();
    this.noteActionEls.clear();
    for (const control of this.noteControls.values()) control.root.remove();
    this.noteControls.clear();
    for (const tabManager of this.patchedTabManagers) {
      const originals = tabManager.__claudianSearchOverlayOriginals;
      if (!originals) continue;
      if (originals.createTab) tabManager.createTab = originals.createTab;
      if (originals.createNewConversation) tabManager.createNewConversation = originals.createNewConversation;
      if (originals.openConversation) tabManager.openConversation = originals.openConversation;
      if (originals.closeTab) tabManager.closeTab = originals.closeTab;
      delete tabManager.__claudianSearchOverlayOriginals;
    }
    this.patchedTabManagers.clear();
    for (const tabBar of this.patchedTabBars) {
      const originalUpdate = tabBar.__claudianSearchOverlayOriginalUpdate;
      if (originalUpdate) tabBar.update = originalUpdate;
      delete tabBar.__claudianSearchOverlayOriginalUpdate;
    }
    this.patchedTabBars.clear();
    for (const view of this.patchedViews) {
      const originalCreateNewTab = view.__claudianSearchOverlayOriginalCreateNewTab;
      if (originalCreateNewTab) view.createNewTab = originalCreateNewTab;
      delete view.__claudianSearchOverlayOriginalCreateNewTab;
    }
    this.patchedViews.clear();
  }

  injectRuntimeStyles() {
    this.styleEl = document.createElement("style");
    this.styleEl.textContent = `
      .claudian-search-overlay {
        align-self: center !important;
        flex: 0 0 auto !important;
        margin-inline-start: 0 !important;
        position: relative !important;
        top: auto !important;
        right: auto !important;
      }
      .claudian-search-overlay__popover {
        position: absolute !important;
        right: 0 !important;
        top: 36px !important;
        z-index: 1000 !important;
      }
      .claudian-search-overlay__toolbar {
        align-items: center !important;
        display: flex !important;
        gap: 8px !important;
        position: absolute !important;
        right: 16px !important;
        top: 12px !important;
        z-index: 40 !important;
      }
      .claudian-search-overlay__host {
        container-type: inline-size !important;
        position: relative !important;
      }
      .claudian-search-overlay__result {
        display: flex !important;
        flex: 0 0 auto !important;
        flex-direction: column !important;
        height: 112px !important;
        min-height: 112px !important;
        overflow: hidden !important;
        white-space: normal !important;
      }
      .claudian-search-overlay__result-title,
      .claudian-search-overlay__source {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      .claudian-search-overlay__excerpt {
        display: -webkit-box !important;
        -webkit-box-orient: vertical !important;
        -webkit-line-clamp: 3 !important;
        overflow: hidden !important;
      }
      .claudian-search-overlay__meta {
        display: none !important;
      }
      .claudian-search-overlay__toast {
        pointer-events: none !important;
        position: fixed !important;
        text-align: center !important;
        z-index: 1000 !important;
      }
      .claudian-note-entry-control {
        align-items: center !important;
        display: none !important;
        flex: 0 0 auto !important;
        gap: 6px !important;
        margin-inline-start: 0 !important;
        max-width: min(360px, 38vw) !important;
        position: static !important;
      }
      .claudian-note-entry-control.is-visible {
        display: flex !important;
      }
      .claudian-note-entry-control__label {
        color: var(--text-muted) !important;
        font-size: 12px !important;
        max-width: 180px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      .claudian-note-entry-control__button {
        align-items: center !important;
        background: var(--background-modifier-hover) !important;
        border: 1px solid var(--background-modifier-border) !important;
        border-radius: 999px !important;
        color: var(--text-muted) !important;
        cursor: pointer !important;
        display: inline-flex !important;
        font-size: 11px !important;
        height: 22px !important;
        justify-content: center !important;
        min-width: 28px !important;
        padding: 0 8px !important;
      }
      .claudian-note-entry-control__button.is-hidden {
        display: none !important;
      }
      .claudian-note-entry-control__button:hover,
      .claudian-note-entry-control__button.is-active {
        background: var(--interactive-accent) !important;
        color: var(--text-on-accent) !important;
      }
      .claudian-note-entry-control__button.is-secondary {
        min-width: 44px !important;
      }
      .claudian-note-entry-action {
        color: var(--text-accent) !important;
      }
    `;
    document.head.appendChild(this.styleEl);
  }

  scheduleScan() {
    if (this.scanTimer) window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => this.injectIntoAllClaudianViews(), 120);
  }

  injectIntoAllClaudianViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    for (const leaf of leaves) this.injectIntoView(leaf.view);
  }

  findOverlayHost(view, claudianRoot) {
    if (!view || !view.containerEl || !claudianRoot) return null;
    return (
      view.containerEl.querySelector(".claudian-header") ||
      view.containerEl.querySelector(".claudian-tab-bar-container") ||
      view.containerEl.querySelector(".claudian-tab-badges")?.parentElement ||
      claudianRoot
    );
  }

  injectIntoView(view) {
    if (!view || !view.containerEl) return;
    if (this.activePanels.has(view)) return;

    const claudianRoot = view.containerEl.querySelector(".claudian-container");
    const header = this.findOverlayHost(view, claudianRoot);
    if (!claudianRoot || !header) return;

    this.patchTabManagerForSlotLimits(view);
    this.patchViewTabBar(view);
    this.patchViewCreateNewTab(view);

    const root = document.createElement("div");
    root.className = "claudian-search-overlay";

    const button = document.createElement("button");
    button.className = "claudian-search-overlay__button";
    button.type = "button";
    button.setAttribute("aria-label", "Search Claudian conversations");
    setIcon(button, "search");

    const popover = document.createElement("div");
    popover.className = "claudian-search-overlay__popover";

    const inputRow = document.createElement("div");
    inputRow.className = "claudian-search-overlay__input-row";

    const input = document.createElement("input");
    input.className = "claudian-search-overlay__input";
    input.type = "search";
    input.placeholder = "搜索当前对话...";
    input.autocomplete = "off";

    const refresh = document.createElement("button");
    refresh.className = "claudian-search-overlay__refresh";
    refresh.type = "button";
    refresh.setAttribute("aria-label", "Refresh index");
    setIcon(refresh, "refresh-cw");

    const status = document.createElement("div");
    status.className = "claudian-search-overlay__status";
    status.textContent = "输入关键词检索当前 Claudian 对话";

    const results = document.createElement("div");
    results.className = "claudian-search-overlay__results";

    inputRow.append(input, refresh);
    popover.append(inputRow, status, results);
    root.append(button, popover);

    const noteControl = this.createNoteEntryControl(view);
    const toolbar = document.createElement("div");
    toolbar.className = "claudian-search-overlay__toolbar";
    header.classList.add("claudian-search-overlay__host");
    claudianRoot.classList.add("claudian-search-overlay__host");
    toolbar.append(noteControl.root, root);
    claudianRoot.appendChild(toolbar);

    const panel = { view, root, button, popover, input, refresh, status, results, toolbar, scopeKey: "" };
    this.activePanels.set(view, panel);
    this.noteControls.set(view, noteControl);
    this.renderNoteEntryControl(view);
    this.applyScopedTabPresentation(view);

    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (root.classList.contains("is-open")) {
        root.classList.remove("is-open");
        return;
      }
      await this.ensureIndex();
      this.openPanel(panel);
    });

    input.addEventListener("input", () => this.queueSearch(panel));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") root.classList.remove("is-open");
    });

    refresh.addEventListener("click", async (event) => {
      event.stopPropagation();
      await this.rebuildIndex();
      this.renderSearch(panel);
      new Notice(`Claudian Search indexed ${this.index.length} Codex messages`);
    });

    document.addEventListener("click", (event) => {
      if (!root.contains(event.target)) root.classList.remove("is-open");
    }, { capture: true });
  }

  scheduleNoteActionScan() {
    if (this.noteActionTimer) window.clearTimeout(this.noteActionTimer);
    this.noteActionTimer = window.setTimeout(() => this.injectNoteActionsIntoMarkdownViews(), 160);
  }

  injectNoteActionsIntoMarkdownViews() {
    const leaves = this.app.workspace.getLeavesOfType(NOTE_ENTRY_VIEW_TYPE_MARKDOWN);
    for (const leaf of leaves) {
      const view = leaf && leaf.view;
      if (!view || !view.file || typeof view.addAction !== "function") continue;
      if (this.noteActions.has(view)) continue;

      const actionEl = view.addAction("bot", "Open note Claudian slots", async () => {
        const file = view.file || this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") {
          new Notice("No active Markdown note.");
          return;
        }
        await this.openNoteClaudianForFile(file, 0);
      });
      actionEl.classList.add("claudian-note-entry-action");
      this.noteActions.set(view, actionEl);
      this.noteActionEls.add(actionEl);
    }
  }

  createNoteEntryControl(view) {
    const root = document.createElement("div");
    root.className = "claudian-note-entry-control";

    const label = document.createElement("div");
    label.className = "claudian-note-entry-control__label";
    label.textContent = "全局窗口";
    root.appendChild(label);

    const globalButtons = [];
    for (let index = 0; index < NOTE_ENTRY_GLOBAL_SLOT_COUNT; index++) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "claudian-note-entry-control__button";
      button.textContent = `G${index + 1}`;
      button.setAttribute("aria-label", `Open global slot ${index + 1}`);
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        await this.activateGlobalSlot(view, index);
      });
      globalButtons.push(button);
      root.appendChild(button);
    }

    const noteButtons = [];
    for (let index = 0; index < NOTE_ENTRY_NOTE_SLOT_COUNT; index++) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "claudian-note-entry-control__button";
      button.textContent = `N${index + 1}`;
      button.setAttribute("aria-label", `Open note slot ${index + 1}`);
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        await this.activateNoteSlot(view, index);
      });
      noteButtons.push(button);
      root.appendChild(button);
    }

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "claudian-note-entry-control__button is-secondary";
    backButton.textContent = "文章";
    backButton.setAttribute("aria-label", "Switch Claudian slot group");
    backButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await this.toggleOppositeScope(view);
    });
    root.appendChild(backButton);

    return { root, label, globalButtons, noteButtons, backButton };
  }

  renderNoteEntryControl(view) {
    const control = this.noteControls.get(view);
    if (!control) return;
    const scope = this.getViewScope(view);
    control.root.classList.add("is-visible");

    const isNote = scope.type === NOTE_ENTRY_SCOPE_NOTE;
    control.label.textContent = isNote ? `文档：${this.basename(scope.notePath)}` : "全局窗口";
    control.label.setAttribute("title", isNote ? scope.notePath : "Global Claudian slots");

    const activeGlobalIndex = this.getActiveGlobalSlotIndex(view);
    const activeNoteIndex = this.getActiveNoteSlotIndex(view);
    const globalCount = this.getGlobalTabIds(view).length;
    const noteCount = isNote ? this.getNoteTabIds(scope.notePath, view).length : 0;
    control.globalButtons.forEach((button, index) => {
      button.classList.toggle("is-hidden", isNote || index >= globalCount);
      button.classList.toggle("is-active", !isNote && index === activeGlobalIndex);
    });
    control.noteButtons.forEach((button, index) => {
      button.classList.toggle("is-hidden", !isNote || index >= noteCount);
      button.classList.toggle("is-active", isNote && index === activeNoteIndex);
    });
    control.backButton.textContent = isNote ? "全局" : "文章";
    control.backButton.setAttribute("title", isNote ? "切换到全局窗口" : "切换到当前文章窗口");
    control.backButton.style.display = "";
  }

  renderAllNoteEntryControls() {
    for (const view of this.noteControls.keys()) {
      this.renderNoteEntryControl(view);
      this.applyScopedTabPresentation(view);
    }
  }

  getViewScope(view) {
    if (this.activeNoteScope && this.activeNoteScope.view === view) {
      return {
        type: NOTE_ENTRY_SCOPE_NOTE,
        notePath: this.activeNoteScope.notePath
      };
    }
    return { type: NOTE_ENTRY_SCOPE_GLOBAL };
  }

  async activateGlobalSlot(view, slotIndex = 0) {
    await this.ensureClaudianMaxTabs();
    const targetView = view || await this.ensureClaudianView();
    if (!targetView) return;

    this.injectIntoView(targetView);
    const tabManager = this.getTabManager(targetView);
    if (!tabManager) return;

    const normalizedIndex = Math.max(0, Math.min(NOTE_ENTRY_GLOBAL_SLOT_COUNT - 1, slotIndex));
    this.activeNoteScope = null;
    this.normalizeScopedTabs(targetView);
    let globalIds = this.getGlobalTabIds(targetView);

    if (!globalIds[normalizedIndex]) {
      if (normalizedIndex > globalIds.length) {
        new Notice(`请先创建 G${globalIds.length + 1}。`);
        return;
      }
      const created = await this.createScopedTab(targetView, void 0, true);
      if (!created) return;
      globalIds = this.getGlobalTabIds(targetView);
    }

    const targetId = globalIds[normalizedIndex];
    if (targetId) await tabManager.switchToTab(targetId);

    this.refreshNativeTabBar(targetView);
    this.renderAllNoteEntryControls();
    this.showScopedNotice(targetView, "已切回全局窗口");
  }

  async toggleOppositeScope(view) {
    const scope = this.getViewScope(view);
    if (scope.type === NOTE_ENTRY_SCOPE_NOTE) {
      await this.activateGlobalSlot(view, 0);
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    let file = activeFile && activeFile.extension === "md" ? activeFile : null;
    if (!file && this.noteEntryState.lastNotePath) {
      const abstractFile = this.app.vault.getAbstractFileByPath(this.noteEntryState.lastNotePath);
      file = abstractFile && abstractFile.extension === "md" ? abstractFile : null;
    }

    if (!file) {
      new Notice("没有可切换的文章；请先在某篇 Markdown 里点 AI 图标。");
      return;
    }

    await this.openNoteClaudianForFile(file, 0);
  }

  async activateNoteSlot(view, slotIndex) {
    if (!this.activeNoteScope || this.activeNoteScope.view !== view) {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return;
      await this.openNoteClaudianForFile(file, slotIndex);
      return;
    }

    const tabManager = this.getTabManager(view);
    if (!tabManager) return;

    const notePath = this.activeNoteScope.notePath;
    const normalizedIndex = Math.max(0, Math.min(NOTE_ENTRY_NOTE_SLOT_COUNT - 1, slotIndex));
    let noteIds = this.getNoteTabIds(notePath, view);
    if (!noteIds[normalizedIndex]) {
      if (normalizedIndex > noteIds.length) {
        new Notice(`请先创建 N${noteIds.length + 1}。`);
        return;
      }
      await this.ensureNoteSlot(view, notePath, normalizedIndex, true);
      noteIds = this.getNoteTabIds(notePath, view);
    }

    const targetId = noteIds[normalizedIndex];
    if (targetId) await tabManager.switchToTab(targetId);
    this.refreshNativeTabBar(view);
    this.renderAllNoteEntryControls();
  }

  getActiveGlobalSlotIndex(view) {
    const tabManager = this.getTabManager(view);
    if (!tabManager || typeof tabManager.getActiveTabId !== "function") return -1;
    const activeId = tabManager.getActiveTabId();
    return this.getGlobalTabIds(view).indexOf(activeId);
  }

  getActiveNoteSlotIndex(view) {
    const tabManager = this.getTabManager(view);
    if (!tabManager || typeof tabManager.getActiveTabId !== "function") return -1;
    const activeId = tabManager.getActiveTabId();
    const scope = this.getViewScope(view);
    if (scope.type !== NOTE_ENTRY_SCOPE_NOTE || !scope.notePath) return -1;
    return this.getNoteTabIds(scope.notePath, view).indexOf(activeId);
  }

  async loadNoteEntryState() {
    try {
      const data = await this.loadData();
      const state = data && data[NOTE_ENTRY_DATA_KEY];
      if (state && typeof state === "object" && !Array.isArray(state)) {
        this.noteEntryState = {
          notes: state.notes && typeof state.notes === "object" && !Array.isArray(state.notes) ? state.notes : {},
          globalTabIds: Array.isArray(state.globalTabIds) ? state.globalTabIds.filter(Boolean) : [],
          lastNotePath: typeof state.lastNotePath === "string" ? state.lastNotePath : ""
        };
      }
    } catch (error) {
      this.noteEntryState = { notes: {}, globalTabIds: [], lastNotePath: "" };
    }
  }

  async saveNoteEntryState() {
    try {
      const data = await this.loadData() || {};
      data[NOTE_ENTRY_DATA_KEY] = this.noteEntryState;
      await this.saveData(data);
    } catch (error) {
      new Notice("Failed to save Claudian note-entry state.");
    }
  }

  async handleNoteRenamed(file, oldPath) {
    if (!file || file.extension !== "md") return;
    const notes = this.noteEntryState.notes;
    if (!notes[oldPath]) return;
    notes[file.path] = {
      ...notes[oldPath],
      updatedAt: Date.now()
    };
    delete notes[oldPath];
    if (this.activeNoteScope?.notePath === oldPath) {
      this.activeNoteScope.notePath = file.path;
      this.renderAllNoteEntryControls();
    }
    if (this.noteEntryState.lastNotePath === oldPath) {
      this.noteEntryState.lastNotePath = file.path;
    }
    await this.saveNoteEntryState();
  }

  getClaudianPlugin() {
    return this.app.plugins.plugins[PLUGIN_ID_CLAUDIAN] || this.app.plugins.plugins[LEGACY_PLUGIN_ID_CLAUDIAN] || null;
  }

  getClaudianPluginId() {
    if (this.app.plugins.plugins[PLUGIN_ID_CLAUDIAN]) return PLUGIN_ID_CLAUDIAN;
    if (this.app.plugins.plugins[LEGACY_PLUGIN_ID_CLAUDIAN]) return LEGACY_PLUGIN_ID_CLAUDIAN;
    return PLUGIN_ID_CLAUDIAN;
  }

  async ensureClaudianMaxTabs() {
    const claudian = this.getClaudianPlugin();
    if (claudian && claudian.settings) {
      const current = Number(claudian.settings.maxTabs || 0);
      if (!Number.isFinite(current) || current < NOTE_ENTRY_TARGET_MAX_TABS) {
        claudian.settings.maxTabs = NOTE_ENTRY_TARGET_MAX_TABS;
        if (typeof claudian.saveSettings === "function") {
          await claudian.saveSettings();
        }
      }
      return;
    }

    await this.ensureClaudianMaxTabsOnDisk();
  }

  async ensureClaudianMaxTabsOnDisk() {
    const basePath = this.app.vault.adapter && this.app.vault.adapter.basePath;
    if (!basePath) return;
    const settingsPath = path.join(basePath, ".claudian", "claudian-settings.json");
    if (!fs.existsSync(settingsPath)) return;

    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const current = Number(settings.maxTabs || 0);
      if (!Number.isFinite(current) || current < NOTE_ENTRY_TARGET_MAX_TABS) {
        settings.maxTabs = NOTE_ENTRY_TARGET_MAX_TABS;
        fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      }
    } catch (error) {
      // Best effort only; Claudian settings will be retried when the plugin object is available.
    }
  }

  getTabManager(view) {
    if (!view) return null;
    if (typeof view.getTabManager === "function") return view.getTabManager();
    return view.tabManager || null;
  }

  getAllTabs(view) {
    const tabManager = this.getTabManager(view);
    return tabManager && typeof tabManager.getAllTabs === "function" ? tabManager.getAllTabs() : [];
  }

  getTabIdSet(view) {
    return new Set(this.getAllTabs(view).map((tab) => tab.id));
  }

  isEmptyTab(tab) {
    const messages = tab && tab.state && Array.isArray(tab.state.messages) ? tab.state.messages : [];
    return !!tab && !tab.conversationId && messages.length === 0 && !(tab.state && tab.state.isStreaming);
  }

  setTabCurrentNote(tab, notePath, startSession = false) {
    const fileContextManager = tab?.ui?.fileContextManager;
    if (!fileContextManager || typeof fileContextManager.setCurrentNote !== "function") return;
    fileContextManager.setCurrentNote(notePath);
    if (startSession && typeof fileContextManager.startSession === "function") {
      fileContextManager.startSession();
    }
  }

  setBlankTabCurrentNote(tab, notePath) {
    this.setTabCurrentNote(tab, notePath, true);
    const fileContextManager = tab?.ui?.fileContextManager;
    if (!fileContextManager) return;
    for (const delay of [0, 50, 250, 600]) {
      window.setTimeout(() => {
        if (!tab.conversationId) {
          this.setTabCurrentNote(tab, notePath, true);
        }
      }, delay);
    }
  }

  getConversationMessageCount(conversationId) {
    if (!conversationId) return 0;
    const claudian = this.getClaudianPlugin();
    if (!claudian || typeof claudian.getConversationSync !== "function") return 0;
    const conversation = claudian.getConversationSync(conversationId);
    return conversation && Array.isArray(conversation.messages) ? conversation.messages.length : 0;
  }

  isConversationEffectivelyEmpty(conversationId) {
    return !!conversationId && this.isConversationAvailable(conversationId) && this.getConversationMessageCount(conversationId) === 0;
  }

  getNoteState(notePath) {
    const notes = this.noteEntryState.notes;
    const noteState = notes[notePath] && typeof notes[notePath] === "object" ? notes[notePath] : {};
    noteState.slots = Array.isArray(noteState.slots) ? noteState.slots.slice(0, NOTE_ENTRY_NOTE_SLOT_COUNT) : [];
    noteState.tabIds = Array.isArray(noteState.tabIds) ? noteState.tabIds.slice(0, NOTE_ENTRY_NOTE_SLOT_COUNT) : [];
    notes[notePath] = noteState;
    return noteState;
  }

  normalizeScopedTabs(view) {
    const liveIds = this.getTabIdSet(view);
    this.noteEntryState.globalTabIds = (this.noteEntryState.globalTabIds || [])
      .filter((id, index, ids) => liveIds.has(id) && ids.indexOf(id) === index)
      .slice(0, NOTE_ENTRY_GLOBAL_SLOT_COUNT);

    for (const [notePath, noteState] of Object.entries(this.noteEntryState.notes || {})) {
      if (!noteState || typeof noteState !== "object") continue;
      noteState.tabIds = Array.isArray(noteState.tabIds)
        ? noteState.tabIds.filter((id, index, ids) => liveIds.has(id) && ids.indexOf(id) === index).slice(0, NOTE_ENTRY_NOTE_SLOT_COUNT)
        : [];
      noteState.slots = Array.isArray(noteState.slots) ? noteState.slots.slice(0, NOTE_ENTRY_NOTE_SLOT_COUNT) : [];
      this.noteEntryState.notes[notePath] = noteState;
    }

    if (this.noteEntryState.globalTabIds.length === 0) {
      const active = this.getActiveTab(view);
      const first = active || this.getAllTabs(view)[0];
      if (first) this.noteEntryState.globalTabIds = [first.id];
    }
  }

  getNoteTabIds(notePath, view) {
    this.normalizeScopedTabs(view);
    return this.getNoteState(notePath).tabIds;
  }

  getGlobalTabIds(view) {
    this.normalizeScopedTabs(view);
    return this.noteEntryState.globalTabIds || [];
  }

  getScopedTabIds(view) {
    const scope = this.getViewScope(view);
    return scope.type === NOTE_ENTRY_SCOPE_NOTE
      ? this.getNoteTabIds(scope.notePath, view)
      : this.getGlobalTabIds(view);
  }

  isTabAssigned(tabId) {
    if ((this.noteEntryState.globalTabIds || []).includes(tabId)) return true;
    return Object.values(this.noteEntryState.notes || {}).some((noteState) => (
      noteState && Array.isArray(noteState.tabIds) && noteState.tabIds.includes(tabId)
    ));
  }

  findAssignedNoteSlotByTabId(tabId) {
    if (!tabId) return null;
    for (const [notePath, noteState] of Object.entries(this.noteEntryState.notes || {})) {
      if (!noteState || !Array.isArray(noteState.tabIds)) continue;
      const index = noteState.tabIds.indexOf(tabId);
      if (index >= 0) return { notePath, index };
    }
    return null;
  }

  removeAssignedNoteSlot(notePath, index) {
    const noteState = this.getNoteState(notePath);
    if (index < 0 || index >= NOTE_ENTRY_NOTE_SLOT_COUNT) return;
    noteState.tabIds.splice(index, 1);
    noteState.slots.splice(index, 1);
    noteState.updatedAt = Date.now();
  }

  getRestorableNoteSlotCount(notePath) {
    const noteState = this.getNoteState(notePath);
    let count = 0;
    let changed = false;

    for (let index = 0; index < NOTE_ENTRY_NOTE_SLOT_COUNT; index++) {
      const conversationId = noteState.slots[index];
      if (!conversationId) continue;
      if (!this.isConversationAvailable(conversationId) || this.isConversationEffectivelyEmpty(conversationId)) {
        noteState.slots[index] = void 0;
        changed = true;
        continue;
      }
      count = index + 1;
    }

    if (changed) {
      noteState.updatedAt = Date.now();
      void this.saveNoteEntryState();
    }

    return count;
  }

  findReusableEmptyTab(view) {
    return this.getAllTabs(view).find((tab) => !this.isTabAssigned(tab.id) && this.isEmptyTab(tab)) || null;
  }

  isReusableUnassignedTab(view, tab, includeActive = false) {
    if (!tab || this.isTabAssigned(tab.id)) return false;
    if (tab.state && tab.state.isStreaming) return false;
    if (!includeActive && tab.id === this.getTabManager(view)?.getActiveTabId?.()) return false;
    return true;
  }

  findReusableAnyTab(view, includeActive = false) {
    const tabs = this.getAllTabs(view);
    return tabs.find((tab) => this.isReusableUnassignedTab(view, tab, includeActive) && this.isEmptyTab(tab))
      || tabs.find((tab) => this.isReusableUnassignedTab(view, tab, includeActive))
      || null;
  }

  findReusablePoolTab(view, conversationId) {
    return this.findReusableConversationTab(view, conversationId)
      || this.findReusableEmptyTab(view)
      || this.findReusableAnyTab(view)
      || null;
  }

  async prepareReusableTab(view, tab, conversationId, activate = true) {
    const tabManager = this.getTabManager(view);
    if (!tabManager || !tab) return null;

    if (conversationId) {
      if (tab.conversationId !== conversationId) {
        if (tab.controllers?.conversationController?.switchTo) {
          await tab.controllers.conversationController.switchTo(conversationId);
        } else if (tabManager.openConversation) {
          const previousActiveId = tabManager.getActiveTabId?.();
          await tabManager.switchToTab(tab.id);
          await tabManager.openConversation(conversationId);
          if (!activate && previousActiveId && previousActiveId !== tab.id && this.findTabById(view, previousActiveId)) {
            await tabManager.switchToTab(previousActiveId);
          }
        }
      }
    } else if (!this.isEmptyTab(tab)) {
      if (tab.controllers?.conversationController?.createNew) {
        await tab.controllers.conversationController.createNew();
      } else if (tabManager.createNewConversation) {
        const previousActiveId = tabManager.getActiveTabId?.();
        await tabManager.switchToTab(tab.id);
        await tabManager.createNewConversation();
        if (!activate && previousActiveId && previousActiveId !== tab.id && this.findTabById(view, previousActiveId)) {
          await tabManager.switchToTab(previousActiveId);
        }
      }
    }

    if (activate) await tabManager.switchToTab(tab.id);
    return tab;
  }

  hasStreamingNoteTabs(view, notePath) {
    const noteState = this.noteEntryState.notes[notePath];
    const tabIds = noteState && Array.isArray(noteState.tabIds) ? noteState.tabIds : [];
    return tabIds.some((tabId) => {
      const tab = this.findTabById(view, tabId);
      return !!(tab && tab.state && tab.state.isStreaming);
    });
  }

  async releaseInactiveNoteTabs(view, keepNotePath) {
    let changed = false;
    for (const [notePath, noteState] of Object.entries(this.noteEntryState.notes || {})) {
      if (notePath === keepNotePath || !noteState || typeof noteState !== "object") continue;
      if (!Array.isArray(noteState.tabIds) || noteState.tabIds.length === 0) continue;

      if (this.hasStreamingNoteTabs(view, notePath)) {
        new Notice(`“${this.basename(notePath)}”的文档窗口正在输出，暂时不能切换文章窗口。`);
        return false;
      }

      noteState.tabIds = [];
      noteState.updatedAt = Date.now();
      changed = true;
    }

    if (changed) await this.saveNoteEntryState();
    return true;
  }

  findReusableConversationTab(view, conversationId) {
    if (!conversationId) return null;
    return this.getAllTabs(view).find((tab) => !this.isTabAssigned(tab.id) && tab.conversationId === conversationId) || null;
  }

  findReclaimableUnassignedTab(view) {
    const activeId = this.getTabManager(view)?.getActiveTabId?.();
    return this.getAllTabs(view).find((tab) => (
      tab
      && tab.id !== activeId
      && !this.isTabAssigned(tab.id)
      && !(tab.state && tab.state.isStreaming)
    )) || null;
  }

  async reclaimOneUnassignedTab(view) {
    const tabManager = this.getTabManager(view);
    if (!tabManager || typeof tabManager.closeTab !== "function") return false;
    const tab = this.findReclaimableUnassignedTab(view);
    if (!tab) return false;
    const closed = await tabManager.closeTab(tab.id, true);
    if (closed) {
      await this.unassignMissingTabs(view);
      this.showScopedNotice(view, "已回收一个隐藏的历史窗口");
    }
    return !!closed;
  }

  findTabById(view, tabId) {
    return this.getAllTabs(view).find((tab) => tab.id === tabId) || null;
  }

  patchTabManagerForSlotLimits(view) {
    const tabManager = this.getTabManager(view);
    if (!tabManager || this.patchedTabManagers.has(tabManager)) return;
    const originals = tabManager.__claudianSearchOverlayOriginals || {
      createTab: tabManager.createTab,
      createNewConversation: tabManager.createNewConversation,
      openConversation: tabManager.openConversation,
      closeTab: tabManager.closeTab
    };
    tabManager.__claudianSearchOverlayOriginals = originals;

    if (typeof originals.createTab === "function") {
      const originalCreateTab = originals.createTab.bind(tabManager);
      tabManager.createTab = async (...args) => {
        if (!this.bypassScopedTabLimit && !this.canCreateTabInCurrentScope(view)) {
          return null;
        }
        if (!this.bypassScopedTabLimit) {
          const conversationId = args[0];
          const options = args[2] || {};
          const activate = options.activate !== false;
          const reusable = this.findReusablePoolTab(view, conversationId);
          if (reusable) {
            await this.prepareReusableTab(view, reusable, conversationId, activate);
            await this.assignTabToCurrentScope(view, reusable.id);
            const scope = this.getViewScope(view);
            if (!conversationId && scope.type === NOTE_ENTRY_SCOPE_NOTE && scope.notePath) {
              this.setBlankTabCurrentNote(reusable, scope.notePath);
            }
            window.setTimeout(() => {
              this.renderAllNoteEntryControls();
              this.applyScopedTabPresentation(view);
              this.refreshNativeTabBar(view);
            }, 0);
            return reusable;
          }
          if (this.getAllTabs(view).length >= NOTE_ENTRY_TARGET_MAX_TABS) {
            await this.reclaimOneUnassignedTab(view);
          }
        }
        const created = await originalCreateTab(...args);
        if (created && !this.bypassScopedTabLimit) {
          await this.assignTabToCurrentScope(view, created.id);
          const conversationId = args[0];
          const scope = this.getViewScope(view);
          if (!conversationId && scope.type === NOTE_ENTRY_SCOPE_NOTE && scope.notePath) {
            this.setBlankTabCurrentNote(created, scope.notePath);
          }
        }
        window.setTimeout(() => {
          this.renderAllNoteEntryControls();
          this.applyScopedTabPresentation(view);
        }, 0);
        if (!created && !this.bypassScopedTabLimit) {
          new Notice("当前底层 6 个物理窗口已满，且没有可回收的隐藏窗口；请先关闭一个不用的窗口。");
        }
        return created;
      };
    }

    if (typeof originals.createNewConversation === "function") {
      const originalCreateNewConversation = originals.createNewConversation.bind(tabManager);
      tabManager.createNewConversation = async (...args) => {
        await originalCreateNewConversation(...args);
        if (!this.bypassScopedConversationRemember) {
          await this.rememberActiveScopedConversation(view);
        }
        this.renderAllNoteEntryControls();
      };
    }

    if (typeof originals.openConversation === "function") {
      const originalOpenConversation = originals.openConversation.bind(tabManager);
      tabManager.openConversation = async (...args) => {
        await originalOpenConversation(...args);
        if (!this.bypassScopedConversationRemember) {
          await this.rememberActiveScopedConversation(view);
        }
        this.renderAllNoteEntryControls();
      };
    }

    if (typeof originals.closeTab === "function") {
      const originalCloseTab = originals.closeTab.bind(tabManager);
      tabManager.closeTab = async (...args) => {
        const noteSlot = typeof args[0] === "string" ? this.findAssignedNoteSlotByTabId(args[0]) : null;
        const closed = await originalCloseTab(...args);
        if (closed) {
          if (noteSlot) {
            this.removeAssignedNoteSlot(noteSlot.notePath, noteSlot.index);
          }
          await this.unassignMissingTabs(view);
          this.renderAllNoteEntryControls();
          this.applyScopedTabPresentation(view);
        }
        return closed;
      };
    }

    this.patchedTabManagers.add(tabManager);
  }

  patchViewTabBar(view) {
    const tabBar = view && view.tabBar;
    if (!tabBar || typeof tabBar.update !== "function" || this.patchedTabBars.has(tabBar)) return;
    const originalUpdate = tabBar.__claudianSearchOverlayOriginalUpdate || tabBar.update.bind(tabBar);
    tabBar.__claudianSearchOverlayOriginalUpdate = originalUpdate;

    tabBar.update = (items) => {
      originalUpdate(this.filterTabBarItems(view, Array.isArray(items) ? items : []));
    };

    this.patchedTabBars.add(tabBar);
    this.refreshNativeTabBar(view);
  }

  patchViewCreateNewTab(view) {
    if (!view || typeof view.createNewTab !== "function" || this.patchedViews.has(view)) return;
    const originalCreateNewTab = view.__claudianSearchOverlayOriginalCreateNewTab || view.createNewTab.bind(view);
    view.__claudianSearchOverlayOriginalCreateNewTab = originalCreateNewTab;

    view.createNewTab = async (...args) => {
      if (!this.canCreateTabInCurrentScope(view)) return null;
      return await originalCreateNewTab(...args);
    };

    this.patchedViews.add(view);
  }

  filterTabBarItems(view, items) {
    if (!view) return items;
    this.normalizeScopedTabs(view);
    const scope = this.getViewScope(view);
    const isNote = scope.type === NOTE_ENTRY_SCOPE_NOTE;
    const scopedIds = this.getScopedTabIds(view);
    return scopedIds
      .map((tabId, index) => {
        const item = items.find((candidate) => candidate.id === tabId);
        if (!item) return null;
        return {
          ...item,
          index: isNote ? `N${index + 1}` : `G${index + 1}`
        };
      })
      .filter(Boolean);
  }

  refreshNativeTabBar(view) {
    if (!view) return;
    if (typeof view.updateTabBar === "function") {
      view.updateTabBar();
      return;
    }
    const tabManager = this.getTabManager(view);
    if (view.tabBar && tabManager && typeof tabManager.getTabBarItems === "function") {
      view.tabBar.update(tabManager.getTabBarItems());
    }
  }

  async assignTabToCurrentScope(view, tabId) {
    const scope = this.getViewScope(view);
    this.normalizeScopedTabs(view);

    if (scope.type === NOTE_ENTRY_SCOPE_NOTE && scope.notePath) {
      const noteState = this.getNoteState(scope.notePath);
      if (!noteState.tabIds.includes(tabId)) {
        noteState.tabIds.push(tabId);
        noteState.tabIds = noteState.tabIds.slice(0, NOTE_ENTRY_NOTE_SLOT_COUNT);
      }
      noteState.updatedAt = Date.now();
    } else if (!this.noteEntryState.globalTabIds.includes(tabId)) {
      this.noteEntryState.globalTabIds.push(tabId);
      this.noteEntryState.globalTabIds = this.noteEntryState.globalTabIds.slice(0, NOTE_ENTRY_GLOBAL_SLOT_COUNT);
    }

    await this.saveNoteEntryState();
    this.refreshNativeTabBar(view);
  }

  async unassignMissingTabs(view) {
    this.normalizeScopedTabs(view);
    await this.saveNoteEntryState();
    this.refreshNativeTabBar(view);
  }

  canCreateTabInCurrentScope(view) {
    const tabManager = this.getTabManager(view);
    if (!tabManager || typeof tabManager.getAllTabs !== "function") return true;
    const scope = this.getViewScope(view);
    const count = this.getScopedTabIds(view).length;

    if (scope.type === NOTE_ENTRY_SCOPE_NOTE) {
      if (count >= NOTE_ENTRY_NOTE_SLOT_COUNT) {
        new Notice("这篇文档最多 3 个窗口；请使用 N1/N2/N3。");
        return false;
      }
      return true;
    }

    if (count >= NOTE_ENTRY_GLOBAL_SLOT_COUNT) {
      new Notice("全局窗口最多 3 个；请使用 G1/G2/G3，或切到文档窗口。");
      return false;
    }

    return true;
  }

  applyScopedTabPresentation(view) {
    if (!view || !view.containerEl) return;
    this.patchTabManagerForSlotLimits(view);
    this.patchViewTabBar(view);
    this.patchViewCreateNewTab(view);

    const scope = this.getViewScope(view);
    const isNote = scope.type === NOTE_ENTRY_SCOPE_NOTE;
    const container = view.containerEl.querySelector(".claudian-container") || view.containerEl;
    container.classList.toggle("claudian-note-entry-scope-global", !isNote);
    container.classList.toggle("claudian-note-entry-scope-note", isNote);

    this.normalizeScopedTabs(view);
    const scopedIds = this.getScopedTabIds(view);
    const scopedIdSet = new Set(scopedIds);
    const scopeLimit = isNote ? NOTE_ENTRY_NOTE_SLOT_COUNT : NOTE_ENTRY_GLOBAL_SLOT_COUNT;
    const totalTabs = this.getAllTabs(view).length;
    const canReusePhysicalTab = !!this.findReusableAnyTab(view);
    const isPhysicalFull = totalTabs >= NOTE_ENTRY_TARGET_MAX_TABS && !canReusePhysicalTab;
    const isFull = scopedIds.length >= scopeLimit || isPhysicalFull;
    container.classList.toggle("claudian-note-entry-global-full", !isNote && isFull);
    container.classList.toggle("claudian-note-entry-note-full", isNote && isFull);

    const badges = Array.from(view.containerEl.querySelectorAll(".claudian-tab-badge"));
    for (let index = 0; index < badges.length; index++) {
      const badge = badges[index];
      badge.dataset.noteEntryScope = isNote ? NOTE_ENTRY_SCOPE_NOTE : NOTE_ENTRY_SCOPE_GLOBAL;
      badge.dataset.noteEntrySlot = String(index + 1);
      badge.style.display = "";
      badge.textContent = isNote ? `N${index + 1}` : `G${index + 1}`;
    }
  }

  async rememberActiveScopedConversation(view) {
    const scope = this.getViewScope(view);
    if (scope.type !== NOTE_ENTRY_SCOPE_NOTE || !scope.notePath) return;

    const slotIndex = this.getActiveNoteSlotIndex(view);
    if (slotIndex < 0 || slotIndex >= NOTE_ENTRY_NOTE_SLOT_COUNT) return;

    const active = this.getActiveConversation(view);
    if (!active.conversationId) return;

    const noteState = this.getNoteState(scope.notePath);
    const previousConversationId = noteState.slots[slotIndex];
    noteState.slots[slotIndex] = active.conversationId;
    noteState.updatedAt = Date.now();
    await this.ensureConversationCurrentNote(active.conversationId, scope.notePath);
    if (previousConversationId !== active.conversationId) {
      await this.saveNoteEntryState();
    }
  }

  async createScopedTab(view, conversationId = void 0, activate = true) {
    const tabManager = this.getTabManager(view);
    if (!tabManager || typeof tabManager.createTab !== "function") return null;
    if (!this.canCreateTabInCurrentScope(view)) return null;

    const reusable = this.findReusablePoolTab(view, conversationId);
    if (reusable) {
      await this.prepareReusableTab(view, reusable, conversationId, activate);
      await this.assignTabToCurrentScope(view, reusable.id);
      return reusable;
    }

    const previousBypass = this.bypassScopedTabLimit;
    this.bypassScopedTabLimit = true;
    try {
      if (this.getAllTabs(view).length >= NOTE_ENTRY_TARGET_MAX_TABS) {
        await this.reclaimOneUnassignedTab(view);
      }
      const created = await tabManager.createTab(conversationId, void 0, { activate });
      if (created) await this.assignTabToCurrentScope(view, created.id);
      if (!created && this.getAllTabs(view).length >= NOTE_ENTRY_TARGET_MAX_TABS) {
        new Notice("当前底层 6 个物理窗口已满，且没有可回收的隐藏窗口；请先关闭一个不用的窗口。");
      }
      return created;
    } finally {
      this.bypassScopedTabLimit = previousBypass;
    }
  }

  resolveProviderId(view) {
    const active = this.getActiveConversation(view);
    if (active.providerId && active.providerId !== "current") return active.providerId;
    const claudian = this.getClaudianPlugin();
    if (claudian?.settings?.savedProviderModel?.codex) return "codex";
    return claudian?.settings?.settingsProvider || "claude";
  }

  async openNoteClaudianForFile(file, activeSlotIndex = 0) {
    await this.ensureClaudianMaxTabs();
    const view = await this.ensureClaudianView();
    if (!view) {
      new Notice("Unable to open Claudian.");
      return;
    }

    this.injectIntoView(view);
    const tabManager = this.getTabManager(view);
    if (!tabManager) {
      new Notice("Unable to access Claudian tabs.");
      return;
    }

    const notePath = file.path;
    if (!await this.releaseInactiveNoteTabs(view, notePath)) return;

    this.activeNoteScope = { view, notePath };
    this.noteEntryState.lastNotePath = notePath;
    this.normalizeScopedTabs(view);

    const noteIds = this.getNoteTabIds(notePath, view);
    const noteTabs = noteIds.map((id) => this.findTabById(view, id)).filter(Boolean);
    if (noteTabs.some((tab) => tab.state && tab.state.isStreaming)) {
      new Notice("A note slot is streaming. Wait for it to finish before switching note slots.");
      return;
    }

    const normalizedIndex = Math.max(0, Math.min(NOTE_ENTRY_NOTE_SLOT_COUNT - 1, activeSlotIndex));
    const restoreCount = Math.max(1, this.getRestorableNoteSlotCount(notePath), Math.min(noteIds.length, NOTE_ENTRY_NOTE_SLOT_COUNT), normalizedIndex + 1);
    const targetIndex = Math.min(normalizedIndex, restoreCount - 1);
    let targetTab = null;

    for (let index = 0; index < restoreCount; index++) {
      const restored = await this.ensureNoteSlot(view, notePath, index, index === targetIndex);
      if (index === targetIndex) targetTab = restored;
      if (!restored) break;
    }

    if (targetTab) {
      await tabManager.switchToTab(targetTab.id);
      if (targetTab.conversationId) {
        this.setTabCurrentNote(targetTab, notePath);
      } else {
        this.setBlankTabCurrentNote(targetTab, notePath);
      }
    }

    this.refreshNativeTabBar(view);
    this.renderAllNoteEntryControls();
    this.applyScopedTabPresentation(view);
    this.showScopedNotice(view, `已打开 ${this.basename(notePath)} 的文档窗口`);
  }

  async ensureNoteSlot(view, notePath, slotIndex, activate = true) {
    const noteState = this.getNoteState(notePath);
    const normalizedIndex = Math.max(0, Math.min(NOTE_ENTRY_NOTE_SLOT_COUNT - 1, slotIndex));
    let noteIds = this.getNoteTabIds(notePath, view);

    if (noteIds[normalizedIndex]) {
      const existingTab = this.findTabById(view, noteIds[normalizedIndex]);
      if (existingTab) {
        if (existingTab.conversationId) {
          await this.ensureConversationCurrentNote(existingTab.conversationId, notePath);
          this.setTabCurrentNote(existingTab, notePath);
        }
        if (activate) await this.getTabManager(view)?.switchToTab(existingTab.id);
        if (!existingTab.conversationId) {
          this.setBlankTabCurrentNote(existingTab, notePath);
        }
        return existingTab;
      }
    }

    if (normalizedIndex > noteIds.length) {
      new Notice(`请先创建 N${noteIds.length + 1}。`);
      return null;
    }

    let conversationId = noteState.slots[normalizedIndex];
    if (conversationId && (!this.isConversationAvailable(conversationId) || this.isConversationEffectivelyEmpty(conversationId))) {
      conversationId = void 0;
      noteState.slots[normalizedIndex] = void 0;
    }

    if (conversationId) {
      await this.ensureConversationCurrentNote(conversationId, notePath);
    }

    const created = await this.createScopedTab(view, conversationId, activate);
    if (!created) return null;

    if (conversationId) {
      this.setTabCurrentNote(created, notePath);
    } else {
      this.setBlankTabCurrentNote(created, notePath);
    }

    noteIds = this.getNoteTabIds(notePath, view);
    noteState.tabIds = noteIds;
    if (conversationId) {
      noteState.slots[normalizedIndex] = conversationId;
    }
    noteState.updatedAt = Date.now();
    await this.saveNoteEntryState();
    return created;
  }

  isConversationAvailable(conversationId) {
    const claudian = this.getClaudianPlugin();
    return !!(claudian && typeof claudian.getConversationSync === "function" && claudian.getConversationSync(conversationId));
  }

  async ensureConversationCurrentNote(conversationId, notePath) {
    const claudian = this.getClaudianPlugin();
    if (!claudian || typeof claudian.getConversationSync !== "function" || typeof claudian.updateConversation !== "function") return;
    const conversation = claudian.getConversationSync(conversationId);
    if (!conversation || conversation.currentNote === notePath) return;
    await claudian.updateConversation(conversationId, { currentNote: notePath });
  }

  async createNoteConversation(notePath, slotIndex, providerId) {
    const claudian = this.getClaudianPlugin();
    if (!claudian || typeof claudian.createConversation !== "function" || typeof claudian.updateConversation !== "function") {
      throw new Error("Claudian conversation API unavailable");
    }

    const conversation = await claudian.createConversation({ providerId });
    await claudian.updateConversation(conversation.id, {
      title: `${this.basename(notePath)} · N${slotIndex + 1}`,
      currentNote: notePath
    });
    return conversation.id;
  }

  async bindNoteTabsToConversations(tabManager, noteTabs, conversationIds) {
    const previousBypass = this.bypassScopedConversationRemember;
    this.bypassScopedConversationRemember = true;
    try {
      for (let index = 0; index < noteTabs.length; index++) {
        const tab = noteTabs[index];
        const conversationId = conversationIds[index];
        if (!tab || !conversationId) continue;
        if (tab.conversationId === conversationId) continue;
        await tabManager.switchToTab(tab.id);
        if (tab.controllers?.conversationController?.switchTo) {
          await tab.controllers.conversationController.switchTo(conversationId);
        } else if (tabManager.openConversation) {
          await tabManager.openConversation(conversationId);
        }
      }
    } finally {
      this.bypassScopedConversationRemember = previousBypass;
    }
  }

  async cleanupEmptyNoteSlots() {
    let removedEmptySlots = 0;
    let touchedNotes = 0;

    for (const [notePath, noteState] of Object.entries(this.noteEntryState.notes || {})) {
      if (!noteState || typeof noteState !== "object") continue;
      const slots = Array.isArray(noteState.slots) ? noteState.slots : [];
      const tabIds = Array.isArray(noteState.tabIds) ? noteState.tabIds : [];
      const keptSlots = [];
      const keptTabIds = [];
      let changed = false;

      for (let index = 0; index < Math.max(slots.length, tabIds.length); index++) {
        const conversationId = slots[index];
        const tabId = tabIds[index];
        if (conversationId && (!this.isConversationAvailable(conversationId) || this.isConversationEffectivelyEmpty(conversationId))) {
          removedEmptySlots++;
          changed = true;
          continue;
        }
        if (conversationId || tabId) {
          keptSlots.push(conversationId);
          if (tabId) keptTabIds.push(tabId);
        }
      }

      if (changed) {
        noteState.slots = keptSlots.slice(0, NOTE_ENTRY_NOTE_SLOT_COUNT);
        noteState.tabIds = keptTabIds.slice(0, NOTE_ENTRY_NOTE_SLOT_COUNT);
        noteState.updatedAt = Date.now();
        touchedNotes++;
      }
    }

    if (touchedNotes > 0) await this.saveNoteEntryState();
    return { removedEmptySlots, touchedNotes };
  }

  async compactHiddenTabs(view) {
    const targetView = view || await this.ensureClaudianView();
    const tabManager = this.getTabManager(targetView);
    const cleanupReport = await this.cleanupEmptyNoteSlots();
    let closedTabs = 0;
    let skippedStreamingTabs = 0;

    if (targetView && tabManager && typeof tabManager.closeTab === "function") {
      for (const tab of [...this.getAllTabs(targetView)]) {
        if (!this.isReusableUnassignedTab(targetView, tab)) {
          if (tab && !this.isTabAssigned(tab.id) && tab.state && tab.state.isStreaming) skippedStreamingTabs++;
          continue;
        }
        const closed = await tabManager.closeTab(tab.id, true);
        if (closed) closedTabs++;
      }
      await this.unassignMissingTabs(targetView);
      this.renderAllNoteEntryControls();
      this.applyScopedTabPresentation(targetView);
    }

    const clearedSearchRecords = this.index.length;
    this.index = [];
    this.indexBuiltAt = 0;

    return {
      closedTabs,
      skippedStreamingTabs,
      removedEmptySlots: cleanupReport.removedEmptySlots,
      touchedNotes: cleanupReport.touchedNotes,
      clearedSearchRecords,
      physicalTabsAfter: targetView ? this.getAllTabs(targetView).length : 0
    };
  }

  getConversationSummary(conversationId) {
    if (!conversationId) return null;
    const claudian = this.getClaudianPlugin();
    const conversation = claudian && typeof claudian.getConversationSync === "function"
      ? claudian.getConversationSync(conversationId)
      : null;
    if (!conversation) return { id: conversationId, available: false };
    return {
      id: conversationId,
      available: true,
      providerId: conversation.providerId || null,
      title: conversation.title || "",
      messages: Array.isArray(conversation.messages) ? conversation.messages.length : 0,
      currentNote: conversation.currentNote || null
    };
  }

  getTabAssignment(tabId) {
    if ((this.noteEntryState.globalTabIds || []).includes(tabId)) {
      return { scope: NOTE_ENTRY_SCOPE_GLOBAL, slot: this.noteEntryState.globalTabIds.indexOf(tabId) + 1 };
    }
    const noteSlot = this.findAssignedNoteSlotByTabId(tabId);
    if (noteSlot) {
      return { scope: NOTE_ENTRY_SCOPE_NOTE, notePath: noteSlot.notePath, slot: noteSlot.index + 1 };
    }
    return { scope: "unassigned" };
  }

  collectDiagnostics(view) {
    const targetView = view || this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0]?.view || null;
    if (targetView) this.normalizeScopedTabs(targetView);
    const claudian = this.getClaudianPlugin();
    const tabManager = this.getTabManager(targetView);
    const scope = this.getViewScope(targetView);
    const allTabs = targetView ? this.getAllTabs(targetView) : [];
    const savedNotes = Object.entries(this.noteEntryState.notes || {});
    let savedSlots = 0;
    let emptySlots = 0;
    let unavailableSlots = 0;

    for (const [, noteState] of savedNotes) {
      const slots = Array.isArray(noteState.slots) ? noteState.slots : [];
      for (const conversationId of slots) {
        if (!conversationId) continue;
        savedSlots++;
        if (!this.isConversationAvailable(conversationId)) unavailableSlots++;
        else if (this.isConversationEffectivelyEmpty(conversationId)) emptySlots++;
      }
    }

    const memory = {};
    try {
      if (typeof process !== "undefined" && process.memoryUsage) {
        const usage = process.memoryUsage();
        memory.process = {
          rssMB: Math.round(usage.rss / 1024 / 1024),
          heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
          externalMB: Math.round(usage.external / 1024 / 1024)
        };
      }
    } catch (_) {
      // Best effort diagnostics.
    }
    try {
      if (performance.memory) {
        memory.performance = {
          usedJSHeapMB: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024),
          totalJSHeapMB: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024)
        };
      }
    } catch (_) {
      // Best effort diagnostics.
    }

    return {
      generatedAt: new Date().toISOString(),
      maxTabs: claudian?.settings?.maxTabs || null,
      currentScope: scope,
      activeTabId: tabManager?.getActiveTabId?.() || null,
      physicalTabs: allTabs.length,
      globalSlots: (this.noteEntryState.globalTabIds || []).map((tabId, index) => ({
        slot: index + 1,
        tabId,
        conversation: this.getConversationSummary(this.findTabById(targetView, tabId)?.conversationId)
      })),
      currentNoteSlots: scope.type === NOTE_ENTRY_SCOPE_NOTE && scope.notePath
        ? this.getNoteState(scope.notePath).tabIds.map((tabId, index) => ({
          slot: index + 1,
          tabId,
          conversation: this.getConversationSummary(this.findTabById(targetView, tabId)?.conversationId || this.getNoteState(scope.notePath).slots[index])
        }))
        : [],
      savedNotes: savedNotes.length,
      savedSlots,
      emptySlots,
      unavailableSlots,
      unassignedTabs: allTabs.filter((tab) => !this.isTabAssigned(tab.id)).length,
      reusableTabs: allTabs.filter((tab) => this.isReusableUnassignedTab(targetView, tab)).length,
      streamingTabs: allTabs.filter((tab) => tab.state && tab.state.isStreaming).length,
      searchIndexRecords: this.index.length,
      memory,
      tabs: allTabs.map((tab) => ({
        id: tab.id,
        assignment: this.getTabAssignment(tab.id),
        conversationId: tab.conversationId || null,
        providerId: tab.providerId || tab.service?.providerId || null,
        lifecycleState: tab.lifecycleState || null,
        messages: Array.isArray(tab.state?.messages) ? tab.state.messages.length : 0,
        currentNote: tab.ui?.fileContextManager?.getCurrentNotePath?.() || null,
        streaming: !!(tab.state && tab.state.isStreaming)
      }))
    };
  }

  formatSlotStatus(diagnostics) {
    const lines = [];
    lines.push(`当前 scope: ${diagnostics.currentScope.type}${diagnostics.currentScope.notePath ? ` (${diagnostics.currentScope.notePath})` : ""}`);
    lines.push(`物理窗口: ${diagnostics.physicalTabs}/${diagnostics.maxTabs || "?"}`);
    lines.push(`保存文章数: ${diagnostics.savedNotes}`);
    lines.push(`保存 slots: ${diagnostics.savedSlots}；空 slots: ${diagnostics.emptySlots}；失效 slots: ${diagnostics.unavailableSlots}`);
    lines.push(`可回收隐藏 tabs: ${diagnostics.reusableTabs}；未分配 tabs: ${diagnostics.unassignedTabs}；输出中 tabs: ${diagnostics.streamingTabs}`);
    if (diagnostics.memory?.process) {
      lines.push(`内存 RSS: ${diagnostics.memory.process.rssMB} MB；JS heap: ${diagnostics.memory.process.heapUsedMB}/${diagnostics.memory.process.heapTotalMB} MB`);
    }
    lines.push("");
    lines.push("全局窗口:");
    for (const slot of diagnostics.globalSlots) {
      const conv = slot.conversation;
      lines.push(`  G${slot.slot}: ${slot.tabId}${conv?.id ? ` | ${conv.id} | messages=${conv.messages}` : " | blank"}`);
    }
    if (diagnostics.currentNoteSlots.length > 0) {
      lines.push("");
      lines.push("当前文章窗口:");
      for (const slot of diagnostics.currentNoteSlots) {
        const conv = slot.conversation;
        lines.push(`  N${slot.slot}: ${slot.tabId}${conv?.id ? ` | ${conv.id} | messages=${conv.messages}` : " | blank"}`);
      }
    }
    lines.push("");
    lines.push("物理 tabs:");
    for (const tab of diagnostics.tabs) {
      const assignment = tab.assignment.scope === NOTE_ENTRY_SCOPE_NOTE
        ? `N${tab.assignment.slot}:${tab.assignment.notePath}`
        : tab.assignment.scope === NOTE_ENTRY_SCOPE_GLOBAL
          ? `G${tab.assignment.slot}`
          : "unassigned";
      lines.push(`  ${tab.id} | ${assignment} | ${tab.lifecycleState} | ${tab.conversationId || "blank"} | messages=${tab.messages} | note=${tab.currentNote || "-"}`);
    }
    return lines.join("\n");
  }

  async copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  basename(notePath) {
    return String(notePath || "").split("/").pop() || String(notePath || "");
  }

  getPanelForView(view) {
    return this.activePanels.get(view) || null;
  }

  openPanel(panel) {
    panel.root.classList.add("is-open");
    panel.input.placeholder = this.getSearchPlaceholder(panel.view);
    panel.input.focus();
    panel.input.select();
    this.renderSearch(panel);
  }

  positionPopover(panel) {
    // Kept for compatibility with older injected panels; current layout is CSS-driven.
  }

  refreshPanelsForScopeChange() {
    for (const panel of this.activePanels.values()) {
      if (!document.body.contains(panel.root)) {
        this.activePanels.delete(panel.view);
        continue;
      }

      this.renderNoteEntryControl(panel.view);
      this.applyScopedTabPresentation(panel.view);
      void this.rememberActiveScopedConversation(panel.view);

      const scopeKey = this.getScopeKey(panel.view);
      if (scopeKey === panel.scopeKey) continue;

      panel.scopeKey = scopeKey;
      panel.input.placeholder = this.getSearchPlaceholder(panel.view);
      this.renderSearch(panel);
    }
  }

  queueSearch(panel) {
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => this.renderSearch(panel), 120);
  }

  async ensureIndex() {
    if (Date.now() - this.indexBuiltAt < 30000 && this.index.length > 0) return;
    await this.rebuildIndex();
  }

  async rebuildIndex() {
    const basePath = this.getVaultBasePath();
    if (!basePath) {
      this.index = [];
      this.indexBuiltAt = Date.now();
      return;
    }

    const sessionsPath = path.join(basePath, SESSIONS_DIR);
    if (!fs.existsSync(sessionsPath)) {
      this.index = [];
      this.indexBuiltAt = Date.now();
      return;
    }

    const files = fs.readdirSync(sessionsPath)
      .filter((name) => name.endsWith(".meta.json"))
      .map((name) => path.join(sessionsPath, name));

    const records = [];
    for (const filePath of files) {
      const meta = this.readJson(filePath);
      if (!meta || meta.providerId !== "codex") continue;

      const sessionFile = meta.providerState && meta.providerState.sessionFilePath;
      if (!sessionFile || !fs.existsSync(sessionFile)) continue;

      const messages = this.readCodexMessages(sessionFile, meta);
      records.push(...messages);
    }

    records.sort((a, b) => b.timestamp - a.timestamp);
    this.index = records;
    this.indexBuiltAt = Date.now();
  }

  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (adapter && typeof adapter.getBasePath === "function") return adapter.getBasePath();
    return null;
  }

  readJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (_) {
      return null;
    }
  }

  readCodexMessages(sessionFile, meta) {
    const rows = [];
    const lines = fs.readFileSync(sessionFile, "utf8").split(/\r?\n/);

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const raw = lines[lineNo];
      if (!raw.trim()) continue;

      let event;
      try {
        event = JSON.parse(raw);
      } catch (_) {
        continue;
      }

      if (event.type !== "response_item") continue;
      const payload = event.payload || {};
      if (payload.type !== "message") continue;
      if (payload.role !== "user" && payload.role !== "assistant") continue;

      const text = this.extractMessageText(payload);
      if (!this.isIndexableMessage(text)) continue;

      rows.push({
        provider: "codex",
        conversationId: meta.id,
        sessionId: meta.sessionId,
        title: meta.title || "Untitled Codex conversation",
        role: payload.role,
        text,
        textKey: this.makeTextKey(text),
        lineNo: lineNo + 1,
        sessionFile,
        timestamp: this.parseTimestamp(event.timestamp) || meta.updatedAt || meta.createdAt || 0
      });
    }

    return rows;
  }

  extractMessageText(payload) {
    const parts = Array.isArray(payload.content) ? payload.content : [];
    const chunks = [];

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const text = part.text || part.input_text || part.output_text;
      if (typeof text === "string" && text.trim()) chunks.push(text.trim());
    }

    return chunks.join("\n\n").trim();
  }

  parseTimestamp(value) {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  isIndexableMessage(text) {
    if (!text || !text.trim()) return false;
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    if (trimmed.startsWith("# AGENTS.md instructions")) return false;
    if (lower.includes("<permissions instructions>")) return false;
    if (lower.includes("<skills_instructions>")) return false;
    if (lower.includes("[qc-os-self bootstrap]")) return false;
    if (lower.includes("you are an autonomous coding agent") && lower.includes("project-doc")) return false;

    return true;
  }

  getActiveTab(view) {
    if (!view) return null;
    if (typeof view.getActiveTab === "function") return view.getActiveTab();
    if (view.tabManager && typeof view.tabManager.getActiveTab === "function") return view.tabManager.getActiveTab();
    return view.activeTab || null;
  }

  getActiveConversation(view) {
    const tab = this.getActiveTab(view);
    const conversationId = tab && tab.conversationId;
    const claudianPlugin = this.getClaudianPlugin();
    const conversation = claudianPlugin
      && conversationId
      && typeof claudianPlugin.getConversationSync === "function"
        ? claudianPlugin.getConversationSync(conversationId)
        : null;
    const providerId = (conversation && conversation.providerId)
      || (tab && tab.service && tab.service.providerId)
      || (tab && tab.providerId)
      || "current";

    return { tab, conversation, conversationId, providerId };
  }

  getScopeKey(view) {
    const active = this.getActiveConversation(view);
    const messages = active.tab && active.tab.state && Array.isArray(active.tab.state.messages)
      ? active.tab.state.messages
      : [];
    const lastMessage = messages[messages.length - 1];
    const lastId = lastMessage && lastMessage.id ? lastMessage.id : "";
    return `${active.providerId}:${active.conversationId || ""}:${messages.length}:${lastId}`;
  }

  getSearchPlaceholder(view) {
    const active = this.getActiveConversation(view);
    const provider = this.getProviderLabel(active.providerId);
    return active.conversationId ? `搜索当前 ${provider} 对话...` : "搜索当前对话...";
  }

  renderEmptyStatus(panel) {
    const active = this.getActiveConversation(panel.view);
    const records = this.getCurrentConversationRecords(panel.view);
    const provider = this.getProviderLabel(active.providerId);
    if (!active.conversationId) {
      panel.status.textContent = "当前没有打开可搜索的 Claudian 对话";
      return;
    }
    panel.status.textContent = `当前 ${provider} 对话可搜索 ${records.length} 条消息`;
  }

  getCurrentConversationRecords(view) {
    const active = this.getActiveConversation(view);
    const { tab, conversation, conversationId, providerId } = active;
    const messages = tab && tab.state && Array.isArray(tab.state.messages) ? tab.state.messages : [];
    const title = (conversation && conversation.title) || (tab && tab.title) || "当前 Claudian 对话";
    const records = [];

    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
      if (message.isRebuiltContext || message.isInterrupt) continue;
      const text = this.extractRuntimeMessageText(message);
      if (!this.isIndexableMessage(text)) continue;

      records.push({
        provider: providerId,
        conversationId,
        messageId: message.id,
        title,
        role: message.role,
        text,
        textKey: this.makeTextKey(text),
        lineNo: index + 1,
        timestamp: this.parseTimestamp(message.timestamp)
          || (conversation && (conversation.updatedAt || conversation.createdAt))
          || 0
      });
    }

    if (records.length === 0 && conversationId) {
      return this.index.filter((record) => record.conversationId === conversationId);
    }

    return records;
  }

  extractRuntimeMessageText(message) {
    const chunks = [];
    const pushText = (value) => {
      if (typeof value !== "string") return;
      const trimmed = value.trim();
      if (trimmed && !chunks.includes(trimmed)) chunks.push(trimmed);
    };

    pushText(message.displayContent);
    pushText(message.content);

    const blocks = Array.isArray(message.contentBlocks) ? message.contentBlocks : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      pushText(block.text);
      pushText(block.content);
    }

    const contentParts = Array.isArray(message.content) ? message.content : [];
    for (const part of contentParts) {
      if (!part || typeof part !== "object") continue;
      pushText(part.text);
      pushText(part.input_text);
      pushText(part.output_text);
    }

    return chunks.join("\n\n").trim();
  }

  getProviderLabel(providerId) {
    const labels = {
      codex: "Codex",
      claude: "Claude",
      openai: "OpenAI",
      opencode: "OpenCode"
    };
    return labels[String(providerId || "").toLowerCase()] || "AI";
  }

  renderSearch(panel) {
    const query = panel.input.value.trim();
    panel.results.empty();

    if (!query) {
      this.renderEmptyStatus(panel);
      return;
    }

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scopeRecords = this.getCurrentConversationRecords(panel.view);
    const allMatches = scopeRecords
      .filter((record) => terms.every((term) => record.text.toLowerCase().includes(term) || record.title.toLowerCase().includes(term)))
      .map((record) => ({
        record,
        score: this.scoreRecord(record, query, terms)
      }))
      .sort((a, b) => b.score - a.score || a.record.lineNo - b.record.lineNo)
      .map((match) => match.record);
    const matches = allMatches.slice(0, MAX_RESULTS);
    const active = this.getActiveConversation(panel.view);

    panel.status.textContent = matches.length ? `当前对话找到 ${allMatches.length} 条，显示前 ${matches.length} 条` : "当前对话没有找到匹配结果";

    for (const record of matches) {
      const item = document.createElement("div");
      item.className = "claudian-search-overlay__result";
      item.setAttribute("role", "button");
      item.tabIndex = 0;

      const title = document.createElement("div");
      title.className = "claudian-search-overlay__result-title";
      title.textContent = record.role === "user" ? "你发送的消息" : `${this.getProviderLabel(record.provider)} 回复`;

      const source = document.createElement("div");
      source.className = "claudian-search-overlay__source";
      source.textContent = record.conversationId === active.conversationId
        ? `当前对话 · 第 ${record.lineNo} 条消息`
        : record.title;

      const excerpt = document.createElement("div");
      excerpt.className = "claudian-search-overlay__excerpt";
      excerpt.innerHTML = this.highlight(this.makeExcerpt(record.text, terms), terms);

      const meta = document.createElement("div");
      meta.className = "claudian-search-overlay__meta";
      meta.textContent = `${this.formatDate(record.timestamp)} · ${record.messageId ? "可精确定位" : `源记录 line ${record.lineNo}`}`;

      item.append(title, source, excerpt, meta);
      const activateResult = async () => {
        item.classList.add("is-loading");
        panel.status.textContent = "正在定位命中消息...";
        const currentActive = this.getActiveConversation(panel.view);
        const view = record.conversationId && currentActive.conversationId !== record.conversationId
          ? await this.openConversation(record.conversationId)
          : panel.view;
        const located = await this.scrollToRecord(view, record);
        item.classList.remove("is-loading");
        panel.root.classList.remove("is-open");
        this.showScopedNotice(view, located ? "已跳到命中消息附近" : "已找到结果，但当前界面没有渲染出可定位的消息");
      };
      item.addEventListener("click", activateResult);
      item.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        activateResult();
      });

      panel.results.appendChild(item);
    }
  }

  scoreRecord(record, query, terms) {
    const text = String(record.text || "").toLowerCase();
    const title = String(record.title || "").toLowerCase();
    const phrase = String(query || "").trim().toLowerCase();
    let score = 0;

    if (phrase) {
      const phraseTextHits = this.countOccurrences(text, phrase);
      const phraseTitleHits = this.countOccurrences(title, phrase);
      score += phraseTextHits * 120;
      score += phraseTitleHits * 180;
    }

    const termPositions = [];
    for (const term of terms) {
      const textHits = this.countOccurrences(text, term);
      const titleHits = this.countOccurrences(title, term);
      const firstTextHit = text.indexOf(term);
      const firstTitleHit = title.indexOf(term);

      score += Math.min(textHits, 8) * 14;
      score += Math.min(titleHits, 4) * 28;
      if (firstTextHit >= 0) {
        score += Math.max(0, 36 - Math.floor(firstTextHit / 80));
        termPositions.push(firstTextHit);
      }
      if (firstTitleHit >= 0) score += 24;
    }

    if (termPositions.length >= 2) {
      const span = Math.max(...termPositions) - Math.min(...termPositions);
      score += Math.max(0, 70 - Math.floor(span / 12));
    }

    score -= Math.min(12, Math.floor(text.length / 2000));
    return score;
  }

  countOccurrences(text, needle) {
    if (!text || !needle) return 0;
    let count = 0;
    let fromIndex = 0;
    while (fromIndex < text.length) {
      const foundAt = text.indexOf(needle, fromIndex);
      if (foundAt < 0) break;
      count++;
      fromIndex = foundAt + Math.max(needle.length, 1);
    }
    return count;
  }

  makeTextKey(text) {
    return String(text).replace(/\s+/g, " ").trim().toLowerCase();
  }

  makeExcerpt(text, terms) {
    const lower = text.toLowerCase();
    const hits = terms
      .map((term) => ({ term, index: lower.indexOf(term) }))
      .filter((hit) => hit.index >= 0)
      .sort((a, b) => a.index - b.index);
    const firstHit = hits[0];

    if (!firstHit) {
      return text.slice(0, 150).replace(/\s+/g, " ") + (text.length > 150 ? "..." : "");
    }

    const beforeChars = 62;
    const afterChars = 160;
    const start = Math.max(0, firstHit.index - beforeChars);
    const end = Math.min(text.length, firstHit.index + firstHit.term.length + afterChars);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < text.length ? "..." : "";
    return prefix + text.slice(start, end).replace(/\s+/g, " ") + suffix;
  }

  highlight(text, terms) {
    let html = this.escapeHtml(text);
    for (const term of terms) {
      const escaped = this.escapeRegExp(this.escapeHtml(term));
      html = html.replace(new RegExp(escaped, "gi"), (match) => `<mark>${match}</mark>`);
    }
    return html;
  }

  escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  formatDate(timestamp) {
    if (!timestamp) return "Unknown time";
    return new Date(timestamp).toLocaleString();
  }

  async ensureClaudianView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
    if (!leaf) {
      await this.app.commands.executeCommandById(`${this.getClaudianPluginId()}:open-view`);
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
    return leaf ? leaf.view : null;
  }

  async openConversation(conversationId) {
    const view = await this.ensureClaudianView();
    if (!view) return;

    if (view.tabManager && typeof view.tabManager.openConversation === "function") {
      await view.tabManager.openConversation(conversationId);
      return view;
    }

    if (typeof view.openHistoryConversation === "function") {
      await view.openHistoryConversation(conversationId);
      return view;
    }

    const claudianPlugin = this.getClaudianPlugin();
    const claudianView = claudianPlugin && typeof claudianPlugin.getView === "function" ? claudianPlugin.getView() : null;
    if (claudianView && claudianView.tabManager && typeof claudianView.tabManager.openConversation === "function") {
      await claudianView.tabManager.openConversation(conversationId);
      return claudianView;
    }

    return view;
  }

  async scrollToRecord(view, record) {
    const targetView = view || await this.ensureClaudianView();
    if (!targetView || !targetView.containerEl) return false;

    for (let attempt = 0; attempt < 25; attempt++) {
      const messagesEl = this.getActiveMessagesElement(targetView);
      const target = messagesEl ? this.findRenderedMessage(messagesEl, record) : null;
      if (messagesEl && target) {
        messagesEl.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
        target.classList.add(HIGHLIGHT_CLASS);
        messagesEl.scrollTo({ top: Math.max(0, target.offsetTop - 18), behavior: "smooth" });
        window.setTimeout(() => target.classList.remove(HIGHLIGHT_CLASS), 4500);
        return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 160));
    }

    return false;
  }

  showScopedNotice(view, message) {
    if (this.toastEl) this.toastEl.remove();

    const targetView = view || this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0]?.view;
    const container = targetView && targetView.containerEl;
    const rect = container ? container.getBoundingClientRect() : document.body.getBoundingClientRect();
    const width = Math.max(180, Math.min(360, rect.width - 32));

    const toast = document.createElement("div");
    toast.className = "claudian-search-overlay__toast";
    toast.textContent = message;
    toast.style.left = `${rect.left + rect.width / 2}px`;
    toast.style.maxWidth = `${width}px`;
    toast.style.top = `${rect.top + 12}px`;
    toast.style.transform = "translateX(-50%)";
    document.body.appendChild(toast);

    this.toastEl = toast;
    window.setTimeout(() => {
      if (this.toastEl === toast) this.toastEl = null;
      toast.remove();
    }, 2200);
  }

  getActiveMessagesElement(view) {
    const activeTab = this.getActiveTab(view);
    if (activeTab && activeTab.dom && activeTab.dom.messagesEl) return activeTab.dom.messagesEl;

    const visibleMessages = Array.from(view.containerEl.querySelectorAll(".claudian-messages"))
      .filter((el) => el.offsetParent !== null);
    return visibleMessages[0] || view.containerEl.querySelector(".claudian-messages");
  }

  findRenderedMessage(messagesEl, record) {
    if (record.messageId) {
      const exact = messagesEl.querySelector(`[data-message-id="${this.escapeCss(record.messageId)}"]`);
      if (exact) return exact;
    }

    const candidates = Array.from(messagesEl.querySelectorAll(`.claudian-message-${record.role}`));
    if (candidates.length === 0) return null;

    const targetKey = record.textKey || this.makeTextKey(record.text);
    const strongestNeedle = this.pickNeedle(targetKey);

    for (const el of candidates) {
      const textKey = this.makeTextKey(el.textContent || "");
      if (textKey && (textKey.includes(strongestNeedle) || targetKey.includes(textKey.slice(0, 120)))) {
        return el;
      }
    }

    return null;
  }

  escapeCss(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  pickNeedle(textKey) {
    if (textKey.length <= 180) return textKey;
    const middle = Math.floor(textKey.length / 2);
    const start = Math.max(0, middle - 90);
    return textKey.slice(start, start + 180).trim();
  }
};
