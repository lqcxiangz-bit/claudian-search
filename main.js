const { Plugin, Notice, setIcon } = require("obsidian");
const fs = require("fs");
const path = require("path");

const VIEW_TYPE_CLAUDIAN = "claudian-view";
const PLUGIN_ID_CLAUDIAN = "claudian";
const SESSIONS_DIR = ".claudian/sessions";
const MAX_RESULTS = 40;
const HIGHLIGHT_CLASS = "claudian-search-overlay__target";

module.exports = class ClaudianSearchOverlayPlugin extends Plugin {
  async onload() {
    this.index = [];
    this.indexBuiltAt = 0;
    this.activePanels = new Map();
    this.searchTimer = null;
    this.scanTimer = null;
    this.scopeTimer = null;
    this.styleEl = null;
    this.toastEl = null;

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

    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.register(() => this.observer.disconnect());

    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleScan()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleScan()));

    this.scopeTimer = window.setInterval(() => this.refreshPanelsForScopeChange(), 600);
    this.register(() => this.scopeTimer && window.clearInterval(this.scopeTimer));

    this.scheduleScan();
  }

  onunload() {
    if (this.scanTimer) window.clearTimeout(this.scanTimer);
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    if (this.scopeTimer) window.clearInterval(this.scopeTimer);
    if (this.styleEl) this.styleEl.remove();
    if (this.toastEl) this.toastEl.remove();
    for (const panel of this.activePanels.values()) panel.root.remove();
    this.activePanels.clear();
  }

  injectRuntimeStyles() {
    this.styleEl = document.createElement("style");
    this.styleEl.textContent = `
      .claudian-search-overlay {
        align-self: center !important;
        flex: 0 0 auto !important;
        margin-inline-start: 8px !important;
        position: relative !important;
        top: auto !important;
        right: auto !important;
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

  injectIntoView(view) {
    if (!view || !view.containerEl) return;
    if (this.activePanels.has(view)) return;

    const claudianRoot = view.containerEl.querySelector(".claudian-container");
    const header = view.containerEl.querySelector(".claudian-header");
    if (!claudianRoot || !header) return;

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
    header.appendChild(root);

    const panel = { view, root, button, popover, input, refresh, status, results, scopeKey: "" };
    this.activePanels.set(view, panel);

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
      new Notice(`Claudian Search indexed ${this.index.length} fallback messages`);
    });

    document.addEventListener("click", (event) => {
      if (!root.contains(event.target)) root.classList.remove("is-open");
    }, { capture: true });
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

  refreshPanelsForScopeChange() {
    for (const panel of this.activePanels.values()) {
      if (!document.body.contains(panel.root)) {
        this.activePanels.delete(panel.view);
        continue;
      }

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
    if (lower.includes("bootstrap]") && lower.includes("summary.md")) return false;
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
    const claudianPlugin = this.app.plugins.plugins[PLUGIN_ID_CLAUDIAN];
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
      await this.app.commands.executeCommandById(`${PLUGIN_ID_CLAUDIAN}:open-view`);
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

    const claudianPlugin = this.app.plugins.plugins[PLUGIN_ID_CLAUDIAN];
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
