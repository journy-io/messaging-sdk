(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports, require('react')) :
    typeof define === 'function' && define.amd ? define(['exports', 'react'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.JournyMessages = {}, global.React));
})(this, (function (exports, React) { 'use strict';

    function _interopNamespaceDefault(e) {
        var n = Object.create(null);
        if (e) {
            Object.keys(e).forEach(function (k) {
                if (k !== 'default') {
                    var d = Object.getOwnPropertyDescriptor(e, k);
                    Object.defineProperty(n, k, d.get ? d : {
                        enumerable: true,
                        get: function () { return e[k]; }
                    });
                }
            });
        }
        n.default = e;
        return Object.freeze(n);
    }

    var React__namespace = /*#__PURE__*/_interopNamespaceDefault(React);

    class MessageQueue {
        constructor() {
            this.queue = [];
            this.messageMap = {};
            this.allFetchedMessages = [];
            this.readMessageIds = new Set();
        }
        addMessage(message) {
            // Check if message already exists
            const queueMessage = this.messageMap[message.id];
            if (queueMessage) {
                this.updateMessageReceived(queueMessage, message);
                return;
            }
            if (message.expiredAt && new Date(message.expiredAt) < new Date()) {
                return;
            }
            this.queue.push(message);
            this.messageMap[message.id] = message;
            this.allFetchedMessages.push(message);
            this.sortByPriority();
        }
        addMessages(messages) {
            messages.forEach((message) => this.addMessage(message));
        }
        getNextMessage() {
            this.removeExpiredMessages();
            for (const message of this.queue) {
                if (!message.isBanner) {
                    return message;
                }
            }
            return null;
        }
        getNextBanner() {
            this.removeExpiredMessages();
            for (const message of this.queue) {
                if (message.isBanner && !message.received) {
                    return message;
                }
            }
            return null;
        }
        getUnreadNonBannerCount() {
            return this.queue.filter((m) => !m.isBanner && !m.received).length;
        }
        getNonBannerMessages() {
            this.removeExpiredMessages();
            return this.queue.filter((m) => !m.isBanner);
        }
        getBannerMessages() {
            this.removeExpiredMessages();
            return this.queue.filter((m) => m.isBanner === true);
        }
        getAlreadyReceivedIds(messageIds) {
            return messageIds.filter((id) => this.messageMap[id]?.received || this.readMessageIds.has(id));
        }
        removeMessage(messageIds) {
            this.queue = this.queue.filter((m) => !messageIds.includes(m.id));
            messageIds.forEach(id => this.readMessageIds.add(id));
        }
        /** Mark a message as received (user clicked/viewed it) without removing from queue */
        markMessageAsReceived(messageIds) {
            this.setReceived(messageIds, true);
        }
        /**
         * Undo an optimistic receipt the server never accepted. Without this the message
         * reads as received locally while still being unread server-side, so it silently
         * comes back on the next reload.
         */
        markMessagesAsUnreceived(messageIds) {
            this.setReceived(messageIds, false);
            messageIds.forEach((id) => this.readMessageIds.delete(id));
        }
        setReceived(messageIds, received) {
            const updateReceived = (m) => messageIds.includes(m.id) ? { ...m, received } : m;
            this.queue = this.queue.map(updateReceived);
            this.allFetchedMessages = this.allFetchedMessages.map(updateReceived);
            // Keep messageMap in sync so subsequent addMessages calls see the new value
            for (const id of messageIds) {
                if (this.messageMap[id]) {
                    this.messageMap[id] = { ...this.messageMap[id], received };
                }
            }
        }
        getAllMessages() {
            this.removeExpiredMessages();
            return [...this.queue];
        }
        getAllFetchedMessages() {
            return [...this.allFetchedMessages];
        }
        getActiveCount() {
            return this.queue.length;
        }
        getReadCount() {
            return this.allFetchedMessages.filter((m) => this.readMessageIds.has(m.id) && !this.queue.find((q) => q.id === m.id)).length;
        }
        clear() {
            this.queue = [];
            this.allFetchedMessages = [];
            this.readMessageIds.clear();
        }
        size() {
            return this.queue.length;
        }
        sortByCreatedAt(a, b) {
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        }
        sortByPriority() {
            this.queue.sort(this.sortByCreatedAt);
        }
        removeExpiredMessages() {
            const now = new Date();
            this.queue = this.queue.filter((message) => {
                if (message.expiredAt) {
                    return new Date(message.expiredAt) >= now;
                }
                return true;
            });
        }
        updateMessageReceived(queueMessage, message) {
            // Preserve a local received:true — the server can briefly report received:false
            // for a message we just marked locally while the markAsRead call is in flight.
            // Letting that flip back to false re-triggers newNonBannerArrived in loadMessages,
            // which reopens the closed widget and blocks any pending banner from surfacing.
            const updated = {
                ...queueMessage,
                received: queueMessage.received || message.received,
                expired: message.expired,
                status: message.status,
            };
            // Look up by id rather than reference: markMessageAsReceived clones
            // entries in queue/allFetchedMessages independently, so messageMap's
            // reference may already be out of sync with those arrays.
            const idx = this.queue.findIndex((m) => m.id === updated.id);
            if (idx !== -1)
                this.queue[idx] = updated;
            const fetchedIdx = this.allFetchedMessages.findIndex((m) => m.id === updated.id);
            if (fetchedIdx !== -1)
                this.allFetchedMessages[fetchedIdx] = updated;
            this.messageMap[updated.id] = updated;
        }
    }

    const DEFAULT_API_ENDPOINT = 'https://analyze.journy.io';
    const DEFAULT_POLLING_INTERVAL = 30000;
    /**
     * Poll pacing. Every tab draws from a budget shared across the whole write key,
     * so the client has to be a good citizen rather than assume it is alone.
     */
    /** Random spread applied to every scheduled poll, as a fraction of the interval. */
    const POLLING_JITTER_RATIO = 0.2;
    /** Backoff ceiling. Long enough to relieve the server, short enough that a tab recovers on its own. */
    const MAX_BACKOFF_INTERVAL = 300000;
    /** Each consecutive failure multiplies the wait by this. */
    const BACKOFF_MULTIPLIER = 2;
    /**
     * Receipts. The API accepts up to 100 ids per call, so a reader scrolling an
     * inbox should cost one request, not one per message.
     */
    /** How long to collect ids before sending them as one batch. */
    const RECEIPT_BATCH_WINDOW = 1000;
    /** Server-enforced ceiling on `messageIds` per request. */
    const RECEIPT_MAX_BATCH_SIZE = 100;
    /** Attempts per batch before the ids are dropped and reported. */
    const RECEIPT_MAX_ATTEMPTS = 4;
    /** First retry wait after a failed batch; doubles per attempt. */
    const RECEIPT_RETRY_BASE_DELAY = 2000;
    const ROOT_ELEMENT_ID = 'journy-messages-root';
    const DEFAULT_STYLE_ID = 'journy-messages-default';
    const REACT_CHECK_INTERVAL = 100;
    const REACT_WAIT_TIMEOUT = 10000;
    const MESSAGE_CLOSE_DELAY = 300;
    const BANNER_AUTO_DISMISS_MS = 20000;
    const BANNER_FADE_OUT_MS = 200;
    const DEFAULT_WIDGET_SETTINGS = {
        pollingInterval: DEFAULT_POLLING_INTERVAL,
        showReadMessages: true,
        autoExpandOnNew: true,
        displayMode: 'list',
        bannerPosition: 'top-center',
        bannerAutoDismissMs: BANNER_AUTO_DISMISS_MS,
        apiEndpoint: DEFAULT_API_ENDPOINT,
        styles: 'default',
    };
    const STORAGE_KEYS = {
        WIDGET_SETTINGS: 'widget_settings',
        WIDGET_VISIBLE: 'widget_visible',
        WIDGET_COLLAPSED: 'widget_collapsed',
        CURRENT_MESSAGE_ID: 'current_message_id',
    };

    const API_PATHS = {
        IN_APP_MESSAGES: '/sdk/in-app-messages',
    };
    const HTTP_TOO_MANY_REQUESTS = 429;
    function parseRetryAfter(response) {
        const header = response.headers?.get?.('Retry-After');
        if (!header)
            return undefined;
        // Retry-After is either delta-seconds or an HTTP-date (RFC 9110). Our own
        // server sends seconds, but an intermediary may rewrite it to a date; falling
        // back to exponential backoff there would retry sooner than asked.
        const seconds = Number(header);
        if (Number.isFinite(seconds)) {
            return seconds >= 0 ? seconds : undefined;
        }
        const dateMs = Date.parse(header);
        if (Number.isNaN(dateMs))
            return undefined;
        const deltaSeconds = Math.ceil((dateMs - Date.now()) / 1000);
        return deltaSeconds >= 0 ? deltaSeconds : undefined;
    }
    function toError(response) {
        if (response.status === HTTP_TOO_MANY_REQUESTS) {
            return {
                kind: 'rate-limited',
                message: 'Rate limit exceeded',
                status: response.status,
                retryAfterSeconds: parseRetryAfter(response),
            };
        }
        return {
            kind: 'http',
            message: `HTTP error! status: ${response.status}`,
            status: response.status,
        };
    }
    class ApiClient {
        constructor(config) {
            this.config = config;
        }
        getHeaders() {
            const headers = {
                'Content-Type': 'application/json',
            };
            if (this.config.writeKey) {
                headers['Authorization'] = `Bearer ${this.config.writeKey}`;
                headers['x-write-key'] = this.config.writeKey;
            }
            return headers;
        }
        buildUrl(endpoint) {
            const baseUrl = (this.config.apiEndpoint || DEFAULT_API_ENDPOINT).replace(/\/$/, '');
            const entityId = this.config.entityType === 'user'
                ? this.config.userId
                : this.config.accountId;
            if (!entityId) {
                throw new Error(`${this.config.entityType}Id is required`);
            }
            const targetPath = `${API_PATHS.IN_APP_MESSAGES}/${this.config.entityType}/${entityId}${endpoint}`;
            return new URL(targetPath, baseUrl).toString();
        }
        async getUnreadMessages() {
            let response;
            try {
                response = await fetch(this.buildUrl('/unread'), {
                    method: 'GET',
                    headers: this.getHeaders(),
                    mode: 'cors', // Explicitly set CORS mode
                });
            }
            catch (error) {
                return {
                    ok: false,
                    error: { kind: 'network', message: String(error) },
                };
            }
            if (!response.ok) {
                return { ok: false, error: toError(response) };
            }
            try {
                const body = await response.json();
                return { ok: true, data: body.data || [] };
            }
            catch (error) {
                return {
                    ok: false,
                    error: { kind: 'network', message: `Malformed response: ${String(error)}` },
                };
            }
        }
        async markAsRead(messageIds) {
            let response;
            try {
                response = await fetch(this.buildUrl('/received'), {
                    method: 'POST',
                    headers: this.getHeaders(),
                    mode: 'cors',
                    body: JSON.stringify({
                        messageIds: messageIds,
                    }),
                });
            }
            catch (error) {
                return {
                    ok: false,
                    error: { kind: 'network', message: String(error) },
                };
            }
            if (!response.ok) {
                return { ok: false, error: toError(response) };
            }
            try {
                const body = await response.json();
                if (body.data && body.data.markedCount !== messageIds.length) {
                    return {
                        ok: false,
                        error: {
                            kind: 'http',
                            message: `Failed to mark all messages as read. Expected ${messageIds.length} messages, got ${body.data.markedCount}`,
                            status: response.status,
                        },
                    };
                }
                return { ok: true, data: undefined };
            }
            catch (error) {
                return {
                    ok: false,
                    error: { kind: 'network', message: `Malformed response: ${String(error)}` },
                };
            }
        }
    }

    var SDKEventType;
    (function (SDKEventType) {
        SDKEventType["MessageReceived"] = "In-App Message Received";
        SDKEventType["MessageOpened"] = "In-App Message Opened";
        SDKEventType["MessageClosed"] = "In-App Message Closed";
        SDKEventType["MessageLinkClicked"] = "In-App Message Link Clicked";
    })(SDKEventType || (SDKEventType = {}));

    const STORAGE_PREFIX = 'journy_messages_';
    function getStorageKey(key) {
        return `${STORAGE_PREFIX}${key}`;
    }
    function setItem(key, value) {
        try {
            const storageKey = getStorageKey(key);
            localStorage.setItem(storageKey, JSON.stringify(value));
        }
        catch (error) {
            console.warn('Failed to set item in localStorage:', error);
        }
    }
    function getItem(key) {
        try {
            const storageKey = getStorageKey(key);
            const item = localStorage.getItem(storageKey);
            return item ? JSON.parse(item) : null;
        }
        catch (error) {
            console.warn('Failed to get item from localStorage:', error);
            return null;
        }
    }
    function removeItem(key) {
        try {
            const storageKey = getStorageKey(key);
            localStorage.removeItem(storageKey);
        }
        catch (error) {
            console.warn('Failed to remove item from localStorage:', error);
        }
    }

    class EventTracker {
        constructor(analyticsClient) {
            this.analyticsClient = analyticsClient;
            this.eventQueue = [];
            this.flushInterval = null;
            this.loadQueuedEvents();
            this.startFlushInterval();
        }
        track(event, properties) {
            const eventData = {
                event,
                properties,
                timestamp: new Date().toISOString(),
            };
            this.eventQueue.push(eventData);
            this.saveQueuedEvents();
            if (this.isImportantEvent(event)) {
                this.flush().catch((error) => {
                    console.error('Failed to flush events:', error);
                });
            }
        }
        async flush() {
            if (this.eventQueue.length === 0) {
                return;
            }
            const eventsToSend = [...this.eventQueue];
            try {
                const success = await this.analyticsClient.trackEvents(eventsToSend.map(({ event, properties }) => ({
                    event,
                    properties: properties || {},
                })));
                if (success) {
                    // Remove successfully sent events from queue
                    this.eventQueue = this.eventQueue.filter(e => !eventsToSend.includes(e));
                }
            }
            catch (error) {
                console.error('Failed to flush events:', error);
            }
            this.saveQueuedEvents();
        }
        startFlushInterval() {
            this.flushInterval = window.setInterval(() => {
                this.flush().catch((error) => {
                    console.error('Failed to flush events:', error);
                });
            }, EventTracker.FLUSH_INTERVAL_MS);
        }
        destroy() {
            if (this.flushInterval !== null) {
                clearInterval(this.flushInterval);
                this.flushInterval = null;
            }
            // Flush remaining events before destroying
            this.flush().catch((error) => {
                console.error('Failed to flush events on destroy:', error);
            });
        }
        isImportantEvent(event) {
            return EventTracker.IMPORTANT_MESSAGES.includes(event);
        }
        saveQueuedEvents() {
            setItem('event_queue', this.eventQueue);
        }
        loadQueuedEvents() {
            const queued = getItem('event_queue');
            if (queued && Array.isArray(queued)) {
                this.eventQueue = queued;
            }
        }
    }
    EventTracker.FLUSH_INTERVAL_MS = 5000;
    EventTracker.IMPORTANT_MESSAGES = [
        SDKEventType.MessageOpened,
        SDKEventType.MessageClosed,
        SDKEventType.MessageLinkClicked,
    ];

    class MessagingStore {
        constructor(initialState) {
            this.listeners = new Set();
            this.state = initialState;
        }
        getState() {
            return this.state;
        }
        setState(partial) {
            this.state = { ...this.state, ...partial };
            this.listeners.forEach(l => l());
        }
        subscribe(listener) {
            this.listeners.add(listener);
            return () => {
                this.listeners.delete(listener);
            };
        }
        destroy() {
            this.listeners.clear();
        }
    }

    /**
     * Collects read receipts and delivers them as batches.
     *
     * Two problems this exists to solve. The API takes up to 100 ids per call but the
     * UI acknowledges one message at a time, so reading an inbox used to cost one
     * request per message. And a receipt that failed in flight was simply lost — the
     * message stayed unread on the server and came back on the next reload, forever.
     *
     * Ids stay queued until the server confirms them, so a rate-limited receipt is
     * retried rather than dropped.
     */
    class ReceiptQueue {
        constructor(options) {
            this.options = options;
            this.pending = new Set();
            this.inFlight = false;
            this.attempts = 0;
            this.timer = null;
            this.destroyed = false;
            this.batchWindow = options.batchWindow ?? RECEIPT_BATCH_WINDOW;
        }
        add(messageIds) {
            for (const id of messageIds) {
                this.pending.add(id);
            }
            // A full batch cannot grow any further, so there is nothing to wait for.
            if (this.pending.size >= RECEIPT_MAX_BATCH_SIZE) {
                void this.flush();
                return;
            }
            this.schedule(this.batchWindow);
        }
        /** Sends whatever is queued right now, without waiting for the batch window. */
        async flush() {
            this.clearTimer();
            if (this.inFlight || this.pending.size === 0)
                return;
            const batch = Array.from(this.pending).slice(0, RECEIPT_MAX_BATCH_SIZE);
            this.inFlight = true;
            let result;
            try {
                result = await this.options.send(batch);
            }
            finally {
                this.inFlight = false;
            }
            // Torn down mid-flight: the batch was still sent (best effort), but we must
            // not schedule retries or fire onDropped after the owner is gone. A fresh
            // instance re-fetches the unread set and re-acks anything the server kept.
            if (this.destroyed)
                return;
            if (result.ok) {
                this.attempts = 0;
                for (const id of batch) {
                    this.pending.delete(id);
                }
                // More than one batch worth was queued; keep going immediately.
                if (this.pending.size > 0) {
                    this.schedule(0);
                }
                return;
            }
            this.attempts++;
            if (this.attempts >= RECEIPT_MAX_ATTEMPTS) {
                // Give up rather than retry forever, but say so — silently dropping a receipt
                // is what leaves a message unread on the server with nobody any the wiser.
                for (const id of batch) {
                    this.pending.delete(id);
                }
                this.attempts = 0;
                this.options.onDropped?.(batch, result.error);
                // Only this batch is abandoned; any ids beyond the first 100 are a fresh
                // batch that hasn't failed, so keep draining them.
                if (this.pending.size > 0) {
                    this.schedule(0);
                }
                return;
            }
            this.schedule(this.getRetryDelay(result.error));
        }
        destroy() {
            this.destroyed = true;
            this.clearTimer();
            this.pending.clear();
        }
        /** Exposed for assertions; the queue owns its own retry scheduling. */
        getPendingCount() {
            return this.pending.size;
        }
        getRetryDelay(error) {
            if (error.kind === 'rate-limited' && error.retryAfterSeconds !== undefined) {
                return error.retryAfterSeconds * 1000;
            }
            return RECEIPT_RETRY_BASE_DELAY * Math.pow(2, this.attempts - 1);
        }
        schedule(delay) {
            if (this.destroyed)
                return;
            if (this.timer !== null)
                return;
            this.timer = setTimeout(() => {
                this.timer = null;
                void this.flush();
            }, delay);
        }
        clearTimer() {
            if (this.timer !== null) {
                clearTimeout(this.timer);
                this.timer = null;
            }
        }
    }

    function getDebugFlags() {
        if (typeof window === 'undefined')
            return {};
        const flag = window.__JOURNY_DEBUG__;
        if (flag === true)
            return { mockMessages: true, settings: true };
        if (flag && typeof flag === 'object')
            return flag;
        return {};
    }
    function isDebugMockMessages() {
        return getDebugFlags().mockMessages === true;
    }
    function isDebugSettings() {
        return getDebugFlags().settings === true;
    }
    function createRootElement(id, doc = document) {
        let element = doc.getElementById(id);
        if (!element) {
            element = doc.createElement('div');
            element.id = id;
            doc.body.appendChild(element);
        }
        return element;
    }
    function removeRootElement(id, doc = document) {
        const element = doc.getElementById(id);
        if (element) {
            element.remove();
        }
    }
    const STYLES_LINK_ID = 'journy-messages-styles-link';
    const STYLES_TAG_ID = 'journy-messages-custom';
    const DEFAULT_STYLES_TAG_ID = 'journy-messages-default';
    function injectStyleLink(href, doc = document) {
        if (!doc || !doc.head)
            return;
        const existing = doc.getElementById(STYLES_LINK_ID);
        if (existing && existing instanceof HTMLLinkElement && existing.href === href)
            return;
        if (existing)
            existing.remove();
        const link = doc.createElement('link');
        link.id = STYLES_LINK_ID;
        link.rel = 'stylesheet';
        link.href = href;
        doc.head.appendChild(link);
    }
    function injectStyleTag(css, id = STYLES_TAG_ID, doc = document) {
        if (!doc || !doc.head)
            return;
        let style = doc.getElementById(id);
        if (style) {
            style.textContent = css;
            return;
        }
        style = doc.createElement('style');
        style.id = id;
        style.textContent = css;
        doc.head.appendChild(style);
    }
    function removeInjectedStyles(doc = document) {
        if (!doc)
            return;
        const link = doc.getElementById(STYLES_LINK_ID);
        if (link)
            link.remove();
        const style = doc.getElementById(STYLES_TAG_ID);
        if (style)
            style.remove();
        const defaultStyle = doc.getElementById(DEFAULT_STYLES_TAG_ID);
        if (defaultStyle)
            defaultStyle.remove();
    }

    function canAccessWindow(win) {
        try {
            // Accessing .document on a cross-origin window throws DOMException
            return !!win.document;
        }
        catch {
            return false;
        }
    }
    function resolveRenderContext(target) {
        const sourceWindow = window;
        if (!target || target === 'self') {
            return { targetWindow: window, targetDocument: document, isRemote: false, sourceWindow };
        }
        const candidateWindow = target === 'top' ? window.top : window.parent;
        if (!candidateWindow || candidateWindow === window) {
            // Not inside an iframe — 'parent'/'top' is the same as 'self'
            return { targetWindow: window, targetDocument: document, isRemote: false, sourceWindow };
        }
        if (canAccessWindow(candidateWindow)) {
            return {
                targetWindow: candidateWindow,
                targetDocument: candidateWindow.document,
                isRemote: true,
                sourceWindow,
            };
        }
        console.warn(`[JournyMessaging] Cannot access ${target} window (cross-origin). Falling back to rendering inside the current iframe.`);
        return { targetWindow: window, targetDocument: document, isRemote: false, sourceWindow };
    }

    var defaultStyles = "/* ============================================================\n   Journy Widget — Design Tokens\n   Brand palette derived from the Journy logo:\n     navy  (#102a43) — dark background / header\n     blue  (#528afa) — primary / ring\n     orange(#f2994a) — accent / center (compensating to blue)\n\n   Defined on every top-level SDK surface so popup/modal/banner\n   render correctly even when the widget shell is not present\n   (e.g. banner mode renders the message overlay outside\n   `.journy-message-widget`).\n   ============================================================ */\n#journy-messages-root,\n.journy-message-widget,\n.journy-message-banner,\n.journy-message-overlay,\n.journy-message-modal-overlay,\n.journy-banner-settings-host {\n  /* --- Brand --- */\n  --journy-navy:          #102a43;\n  --journy-blue:          #528afa;\n  --journy-blue-hover:    #3b6fd4;\n  --journy-orange:        #f2994a;\n  --journy-orange-hover:  #e07f2a;\n\n  /* --- Surface --- */\n  --journy-surface:       #ffffff;\n  --journy-surface-alt:   #f9fafb;\n  --journy-surface-hover: #f3f4f6;\n\n  /* --- Border --- */\n  --journy-border:        #e5e7eb;\n  --journy-border-strong: #d1d5db;\n\n  /* --- Text --- */\n  --journy-text-primary:  #111827;\n  --journy-text-secondary:#374151;\n  --journy-text-muted:    #6b7280;\n  --journy-text-subtle:   #9ca3af;\n\n  /* --- On-header (text/icons over navy bg) --- */\n  --journy-on-header:           #ffffff;\n  --journy-on-header-muted:     rgba(255, 255, 255, 0.7);\n  --journy-on-header-btn:       rgba(255, 255, 255, 0.85);\n  --journy-on-header-btn-hover: rgba(255, 255, 255, 0.2);\n\n  /* --- Semantic --- */\n  --journy-info:    #528afa;\n  --journy-success: #10b981;\n  --journy-warning: #f59e0b;\n  --journy-error:   #ef4444;\n  --journy-viewed:  #6b7280;\n\n  /* --- Shadow / Overlay --- */\n  --journy-shadow-sm:  0 4px 20px rgba(0, 0, 0, 0.15);\n  --journy-shadow-md:  0 4px 24px rgba(0, 0, 0, 0.2);\n  --journy-overlay-bg: rgba(0, 0, 0, 0.5);\n}\n\n/* ============================================================\n   Widget Container\n   ============================================================ */\n.journy-message-widget {\n  position: fixed;\n  z-index: 10000;\n  background: var(--journy-surface);\n  border-radius: 12px;\n  box-shadow: var(--journy-shadow-sm);\n  overflow: hidden;\n  user-select: none;\n  transform-origin: bottom right;\n}\n\n.journy-message-widget.journy-message-widget-dragging {\n  cursor: grabbing;\n  transition: none;\n  z-index: 10001;\n}\n\n.journy-message-widget.journy-message-widget-expanded {\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n}\n\n.journy-message-widget.journy-message-widget-resizing {\n  transition: none;\n}\n\n/* Expand/collapse: height and top are animated via inline transition so bottom-right stays fixed */\n\n/* ============================================================\n   Widget Header\n   ============================================================ */\n.journy-message-widget-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 12px 16px;\n  background: var(--journy-navy);\n  border-bottom: none;\n  user-select: none;\n  cursor: grab;\n}\n\n.journy-message-widget-header:active {\n  cursor: grabbing;\n}\n\n.journy-message-widget-drag-handle {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  padding: 4px 8px;\n  margin-right: 8px;\n  cursor: grab;\n  flex-shrink: 0;\n}\n\n.journy-message-widget-drag-handle svg {\n  display: block;\n}\n\n.journy-message-widget-header-content {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex: 1;\n  min-width: 0;\n  cursor: inherit;\n}\n\n.journy-message-widget-collapsed .journy-message-widget-header-content {\n  cursor: pointer;\n}\n\n/* ============================================================\n   Collapsed pill mode\n   ============================================================ */\n.journy-message-widget-collapsed {\n  border-radius: 24px;\n  background: var(--journy-navy);\n}\n\n.journy-message-widget-header--pill {\n  background: var(--journy-navy);\n  padding: 6px 6px 6px 10px;\n  gap: 6px;\n  border-bottom: none;\n}\n\n.journy-message-widget-header--pill .journy-message-widget-drag-handle {\n  padding: 2px 4px;\n  margin-right: 0;\n}\n\n.journy-message-widget-logo-wrapper {\n  position: relative;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  flex-shrink: 0;\n}\n\n.journy-message-widget-logo-badge {\n  position: absolute;\n  top: -5px;\n  right: -5px;\n  min-width: 15px;\n  height: 15px;\n  background: var(--journy-orange);\n  color: #fff;\n  border-radius: 8px;\n  font-size: 9px;\n  font-weight: 700;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  padding: 0 3px;\n  border: 1.5px solid var(--journy-navy);\n  pointer-events: none;\n}\n\n.journy-message-widget-pill-title {\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--journy-on-header);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.journy-message-widget-avatar-slot {\n  width: 28px;\n  height: 28px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  flex-shrink: 0;\n}\n\n.journy-message-widget-close--pill {\n  opacity: 0;\n  color: var(--journy-on-header-btn) !important;\n  background: transparent !important;\n  border-radius: 50% !important;\n  width: 26px !important;\n  height: 26px !important;\n  font-size: 18px !important;\n  transition: opacity 0.2s, background-color 0.2s !important;\n}\n\n.journy-message-widget-collapsed:hover .journy-message-widget-close--pill {\n  opacity: 1;\n}\n\n.journy-message-widget-close--pill:hover {\n  background: var(--journy-on-header-btn-hover) !important;\n  color: var(--journy-on-header) !important;\n}\n\n.journy-message-widget-badge {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  min-width: 24px;\n  height: 24px;\n  padding: 0 8px;\n  background: var(--journy-orange);\n  color: var(--journy-on-header);\n  border-radius: 12px;\n  font-size: 12px;\n  font-weight: 600;\n  transition: background-color 0.2s;\n}\n\n.journy-message-widget-badge:hover {\n  background: var(--journy-blue);\n}\n\n.journy-message-widget-title {\n  font-size: 14px;\n  font-weight: 600;\n  color: var(--journy-on-header);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.journy-message-widget-read-count {\n  font-size: 12px;\n  color: var(--journy-on-header-muted);\n  font-weight: 400;\n}\n\n.journy-message-widget-controls {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.journy-message-widget-toggle,\n.journy-message-widget-close {\n  background: none;\n  border: none;\n  font-size: 18px;\n  line-height: 1;\n  cursor: pointer;\n  color: var(--journy-on-header-btn);\n  padding: 4px 8px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n}\n\n.journy-message-widget-toggle:hover,\n.journy-message-widget-close:hover {\n  background-color: var(--journy-on-header-btn-hover);\n  color: var(--journy-on-header);\n}\n\n.journy-message-widget-settings-btn {\n  background: none;\n  border: none;\n  font-size: 16px;\n  line-height: 1;\n  cursor: pointer;\n  color: var(--journy-on-header-btn);\n  padding: 4px 8px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n}\n\n.journy-message-widget-settings-btn:hover {\n  background-color: var(--journy-on-header-btn-hover);\n  color: var(--journy-on-header);\n}\n\n/* ============================================================\n   Widget Content\n   ============================================================ */\n.journy-message-widget-content {\n  padding: 16px;\n  flex: 1;\n  overflow-y: auto;\n  overflow-x: hidden;\n  min-height: 0;\n  scrollbar-width: thin;\n  scrollbar-color: var(--journy-border-strong) transparent;\n}\n\n.journy-message-widget-content::-webkit-scrollbar {\n  width: 8px;\n  height: 8px;\n}\n\n.journy-message-widget-content::-webkit-scrollbar-track {\n  background: transparent;\n}\n\n.journy-message-widget-content::-webkit-scrollbar-thumb {\n  background-color: var(--journy-border-strong);\n  border-radius: 4px;\n  border: 2px solid transparent;\n  background-clip: padding-box;\n}\n\n.journy-message-widget-content::-webkit-scrollbar-thumb:hover {\n  background-color: var(--journy-text-muted);\n}\n\n.journy-message-widget-content--single {\n  display: flex;\n  flex-direction: column;\n}\n\n.journy-message-widget-content--single .journy-message-widget-message {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n}\n\n.journy-message-widget-content--single .journy-message-widget-message .journy-message-content {\n  flex: 1;\n  min-height: 0;\n  overflow: hidden;\n}\n\n/* ============================================================\n   Resize Handle\n   ============================================================ */\n.journy-message-widget-resize-handle {\n  position: absolute;\n  bottom: 0;\n  right: 0;\n  width: 20px;\n  height: 20px;\n  cursor: nwse-resize;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: linear-gradient(135deg, transparent 0%, transparent 40%, var(--journy-border) 40%, var(--journy-border) 100%);\n  z-index: 10;\n  transition: background 0.2s;\n}\n\n.journy-message-widget-resize-handle:hover {\n  background: linear-gradient(135deg, transparent 0%, transparent 40%, var(--journy-border-strong) 40%, var(--journy-border-strong) 100%);\n}\n\n.journy-message-widget-resize-handle svg {\n  width: 12px;\n  height: 12px;\n  opacity: 0.6;\n}\n\n.journy-message-widget-resize-handle:hover svg {\n  opacity: 1;\n}\n\n/* ============================================================\n   Messages\n   ============================================================ */\n.journy-message-widget-message {\n  padding: 0;\n  position: relative;\n  transition: border-color 0.6s ease;\n}\n\n/* In single mode, constrain message content to fill available space with overflow hidden */\n.journy-message-widget-content--single .journy-message-widget-message {\n  overflow: hidden;\n}\n\n.journy-message-widget-message-close {\n  position: absolute;\n  top: 4px;\n  right: 4px;\n  width: 24px;\n  height: 24px;\n  padding: 0;\n  border: none;\n  background: transparent;\n  color: var(--journy-text-muted);\n  font-size: 18px;\n  line-height: 1;\n  cursor: pointer;\n  border-radius: 4px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  transition: background-color 0.2s, color 0.2s;\n  z-index: 1;\n}\n\n.journy-message-widget-message-close:hover {\n  background-color: var(--journy-border);\n  color: var(--journy-text-secondary);\n}\n\n.journy-message-widget-message:has(.journy-message-widget-message-close) .journy-message-content {\n  padding-right: 28px;\n}\n\n.journy-message-widget-nav {\n  background: none;\n  border: none;\n  font-size: 16px;\n  line-height: 1;\n  cursor: pointer;\n  color: var(--journy-text-muted);\n  padding: 2px 6px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 24px;\n  height: 24px;\n}\n\n.journy-message-widget-nav:hover:not(:disabled) {\n  background-color: var(--journy-border);\n  color: var(--journy-text-secondary);\n}\n\n.journy-message-widget-nav:disabled {\n  opacity: 0.4;\n  cursor: default;\n}\n\n.journy-message-widget-message-separated {\n  margin-bottom: 24px;\n  padding-bottom: 24px;\n  border-bottom: 1px solid var(--journy-border);\n}\n\n.journy-message-widget-message-count {\n  font-size: 12px;\n  color: var(--journy-on-header-muted);\n  font-weight: 400;\n  margin-left: 8px;\n  white-space: nowrap;\n  flex-shrink: 0;\n}\n\n.journy-message-widget-position {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 8px;\n  padding: 4px 12px;\n  font-size: 11px;\n  color: var(--journy-text-subtle);\n  font-weight: 500;\n  flex-shrink: 0;\n  border-top: 1px solid var(--journy-border);\n}\n\n.journy-message-widget-position-text {\n  min-width: 32px;\n  text-align: center;\n}\n\n.journy-message-widget-message.journy-message-info {\n  border-left: 4px solid var(--journy-info);\n  padding-left: 12px;\n}\n\n.journy-message-widget-message.journy-message-success {\n  border-left: 4px solid var(--journy-success);\n  padding-left: 12px;\n}\n\n.journy-message-widget-message.journy-message-warning {\n  border-left: 4px solid var(--journy-warning);\n  padding-left: 12px;\n}\n\n.journy-message-widget-message.journy-message-error {\n  border-left: 4px solid var(--journy-error);\n  padding-left: 12px;\n}\n\n.journy-message-widget-message.journy-message-viewed {\n  border-left: 4px solid var(--journy-viewed);\n  padding-left: 12px;\n}\n\n/* ============================================================\n   Message Modal (80vw × 60vh)\n   ============================================================ */\n.journy-message-modal-overlay {\n  position: fixed;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  background-color: var(--journy-overlay-bg);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  z-index: 10002;\n  padding: 20px;\n}\n\n.journy-message-modal {\n  width: 80vw;\n  max-width: 80vw;\n  height: 60vh;\n  max-height: 60vh;\n  background: var(--journy-surface);\n  border-radius: 12px;\n  box-shadow: var(--journy-shadow-md);\n  overflow: hidden;\n  display: flex;\n  flex-direction: column;\n  position: relative;\n}\n\n.journy-message-modal-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 16px 24px;\n  background: var(--journy-surface-alt);\n  border-bottom: 1px solid var(--journy-border);\n  flex-shrink: 0;\n}\n\n.journy-message-modal-title {\n  font-size: 18px;\n  font-weight: 600;\n  color: var(--journy-text-primary);\n}\n\n.journy-message-modal-close {\n  background: none;\n  border: none;\n  font-size: 24px;\n  line-height: 1;\n  cursor: pointer;\n  color: var(--journy-text-muted);\n  padding: 4px 8px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n}\n\n.journy-message-modal-close:hover {\n  background-color: var(--journy-border);\n  color: var(--journy-text-secondary);\n}\n\n.journy-message-modal .journy-message-widget-message {\n  padding: 24px;\n  overflow-y: auto;\n  flex: 1;\n  min-height: 0;\n}\n\n/* ============================================================\n   Timestamp\n   ============================================================ */\n/* Overlay at the bottom of each message card (single mode only) */\n.journy-message-widget-content--single .journy-message-timestamp {\n  position: absolute;\n  bottom: 0;\n  left: 0;\n  right: 0;\n  padding: 32px 12px 8px 12px;\n  background: linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.9) 50%, rgba(255,255,255,1) 60%);\n  font-size: 12px;\n  color: var(--journy-text-muted);\n  line-height: 1.4;\n  pointer-events: none;\n  z-index: 2;\n}\n\n/* Flows naturally in list mode */\n.journy-message-widget-content:not(.journy-message-widget-content--single) .journy-message-timestamp {\n  font-size: 12px;\n  color: var(--journy-text-muted);\n  line-height: 1.4;\n  margin-top: 6px;\n}\n\n.journy-message-content-clickable {\n  cursor: pointer;\n}\n\n.journy-message-content-clickable:hover {\n  opacity: 0.95;\n}\n\n/* ============================================================\n   Legacy Modal Overlay (kept for backward compatibility)\n   ============================================================ */\n.journy-message-overlay {\n  position: fixed;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  background-color: var(--journy-overlay-bg);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  z-index: 10000;\n  opacity: 0;\n  transition: opacity 0.3s ease-in-out;\n  pointer-events: none;\n}\n\n.journy-message-overlay.journy-message-visible {\n  opacity: 1;\n  pointer-events: all;\n}\n\n.journy-message-popup {\n  background: var(--journy-surface);\n  border-radius: 8px;\n  padding: 24px;\n  max-width: 500px;\n  width: 90%;\n  max-height: 80vh;\n  display: flex;\n  flex-direction: column;\n  box-shadow: var(--journy-shadow-sm);\n  position: relative;\n  transform: scale(0.9);\n  transition: transform 0.3s ease-in-out, border-color 0.6s ease;\n}\n\n.journy-message-popup .journy-message-content {\n  flex: 1 1 auto;\n  min-height: 0;\n  overflow-y: auto;\n}\n\n.journy-message-overlay.journy-message-visible .journy-message-popup {\n  transform: scale(1);\n}\n\n.journy-message-popup.journy-message-info    { border-top: 4px solid var(--journy-info); }\n.journy-message-popup.journy-message-success { border-top: 4px solid var(--journy-success); }\n.journy-message-popup.journy-message-warning { border-top: 4px solid var(--journy-warning); }\n.journy-message-popup.journy-message-error   { border-top: 4px solid var(--journy-error); }\n.journy-message-popup.journy-message-viewed  { border-top: 4px solid var(--journy-viewed); }\n\n.journy-message-close {\n  position: absolute;\n  top: 12px;\n  right: 12px;\n  background: none;\n  border: none;\n  font-size: 24px;\n  line-height: 1;\n  cursor: pointer;\n  color: var(--journy-text-muted);\n  padding: 4px 8px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n}\n\n.journy-message-close:hover {\n  background-color: var(--journy-surface-hover);\n  color: var(--journy-text-secondary);\n}\n\n/* ============================================================\n   Message Content\n   ============================================================ */\n.journy-message-title {\n  font-size: 20px;\n  font-weight: 600;\n  margin-bottom: 12px;\n  color: var(--journy-text-primary);\n}\n\n.journy-message-content {\n  font-size: 16px;\n  line-height: 1.6;\n  color: var(--journy-text-secondary);\n  margin-bottom: 16px;\n}\n\n.journy-message-content a {\n  color: var(--journy-blue);\n  text-decoration: underline;\n  transition: color 0.2s;\n}\n\n.journy-message-content a:hover {\n  color: var(--journy-blue-hover);\n}\n\n.journy-message-content p {\n  margin: 0 0 12px 0;\n}\n\n.journy-message-content p:last-child {\n  margin-bottom: 0;\n}\n\n.journy-message-content ul,\n.journy-message-content ol {\n  margin: 12px 0;\n  padding-left: 24px;\n}\n\n.journy-message-content li {\n  margin-bottom: 8px;\n}\n\n/* Headings */\n.journy-message-content h1,\n.journy-message-content h2,\n.journy-message-content h3,\n.journy-message-content h4,\n.journy-message-content h5,\n.journy-message-content h6 {\n  margin: 16px 0 12px 0;\n  font-weight: 600;\n  line-height: 1.3;\n  color: var(--journy-text-primary);\n}\n\n.journy-message-content h1 { font-size: 24px; }\n.journy-message-content h2 { font-size: 20px; }\n.journy-message-content h3 { font-size: 18px; }\n.journy-message-content h4 { font-size: 16px; }\n.journy-message-content h5,\n.journy-message-content h6 { font-size: 14px; }\n\n/* Code */\n.journy-message-content code {\n  background-color: var(--journy-surface-hover);\n  color: var(--journy-error);\n  padding: 2px 6px;\n  border-radius: 4px;\n  font-size: 0.9em;\n  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'source-code-pro', monospace;\n}\n\n.journy-message-content pre {\n  background-color: var(--journy-navy);\n  color: var(--journy-surface-alt);\n  padding: 16px;\n  border-radius: 8px;\n  overflow-x: auto;\n  margin: 12px 0;\n  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'source-code-pro', monospace;\n  font-size: 14px;\n  line-height: 1.5;\n}\n\n.journy-message-content pre code {\n  background-color: transparent;\n  color: inherit;\n  padding: 0;\n  border-radius: 0;\n  font-size: inherit;\n}\n\n/* Text formatting */\n.journy-message-content u              { text-decoration: underline; }\n.journy-message-content s,\n.journy-message-content strike,\n.journy-message-content del            { text-decoration: line-through; }\n.journy-message-content strong         { font-weight: 600; }\n.journy-message-content em             { font-style: italic; }\n\n/* Blockquotes */\n.journy-message-content blockquote {\n  border-left: 4px solid var(--journy-border);\n  padding-left: 16px;\n  margin: 12px 0;\n  color: var(--journy-text-muted);\n  font-style: italic;\n}\n\n/* Tables */\n.journy-message-content table {\n  width: 100%;\n  border-collapse: collapse;\n  margin: 12px 0;\n}\n\n.journy-message-content th,\n.journy-message-content td {\n  border: 1px solid var(--journy-border);\n  padding: 8px 12px;\n  text-align: left;\n}\n\n.journy-message-content th {\n  background-color: var(--journy-surface-alt);\n  font-weight: 600;\n}\n\n/* Horizontal rule */\n.journy-message-content hr {\n  border: none;\n  border-top: 1px solid var(--journy-border);\n  margin: 16px 0;\n}\n\n/* ============================================================\n   Actions\n   ============================================================ */\n.journy-message-actions {\n  display: flex;\n  gap: 12px;\n  margin-top: 20px;\n  flex-wrap: wrap;\n}\n\n.journy-message-action {\n  padding: 10px 20px;\n  border-radius: 6px;\n  font-size: 14px;\n  font-weight: 500;\n  cursor: pointer;\n  border: none;\n  transition: all 0.2s;\n}\n\n.journy-message-action-primary {\n  background-color: var(--journy-blue);\n  color: var(--journy-on-header);\n}\n\n.journy-message-action-primary:hover {\n  background-color: var(--journy-blue-hover);\n}\n\n.journy-message-action-secondary {\n  background-color: var(--journy-border);\n  color: var(--journy-text-secondary);\n}\n\n.journy-message-action-secondary:hover {\n  background-color: var(--journy-border-strong);\n}\n\n.journy-message-action-link {\n  background: none;\n  color: var(--journy-blue);\n  text-decoration: underline;\n  padding: 10px 0;\n}\n\n.journy-message-action-link:hover {\n  color: var(--journy-blue-hover);\n}\n\n/* ============================================================\n   Settings Panel\n   ============================================================ */\n.journy-settings-panel {\n  position: absolute;\n  top: 0;\n  right: 0;\n  bottom: 0;\n  width: 100%;\n  background: var(--journy-surface);\n  z-index: 10;\n  display: flex;\n  flex-direction: column;\n  transform: translateX(100%);\n  transition: transform 0.3s ease;\n}\n\n.journy-settings-panel-open  { transform: translateX(0); }\n.journy-settings-panel-closed { transform: translateX(100%); }\n\n.journy-settings-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 12px 16px;\n  background: var(--journy-surface-alt);\n  border-bottom: 1px solid var(--journy-border);\n  flex-shrink: 0;\n}\n\n.journy-settings-title {\n  font-size: 14px;\n  font-weight: 600;\n  color: var(--journy-text-primary);\n}\n\n.journy-settings-close {\n  background: none;\n  border: none;\n  font-size: 18px;\n  line-height: 1;\n  cursor: pointer;\n  color: var(--journy-text-muted);\n  padding: 4px 8px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n}\n\n.journy-settings-close:hover {\n  background-color: var(--journy-border);\n  color: var(--journy-text-secondary);\n}\n\n.journy-settings-body {\n  padding: 16px;\n  overflow-y: auto;\n  flex: 1;\n}\n\n.journy-settings-item {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 12px 0;\n  border-bottom: 1px solid var(--journy-surface-hover);\n}\n\n.journy-settings-item:last-child {\n  border-bottom: none;\n}\n\n.journy-settings-label {\n  font-size: 13px;\n  font-weight: 500;\n  color: var(--journy-text-secondary);\n}\n\n.journy-settings-select {\n  padding: 6px 10px;\n  border: 1px solid var(--journy-border-strong);\n  border-radius: 6px;\n  font-size: 13px;\n  color: var(--journy-text-secondary);\n  background: var(--journy-surface);\n  cursor: pointer;\n  outline: none;\n  transition: border-color 0.2s;\n}\n\n.journy-settings-select:focus {\n  border-color: var(--journy-blue);\n}\n\n.journy-settings-toggle {\n  position: relative;\n  width: 40px;\n  height: 22px;\n  border-radius: 11px;\n  border: none;\n  background: var(--journy-border-strong);\n  cursor: pointer;\n  padding: 0;\n  transition: background-color 0.2s;\n  flex-shrink: 0;\n}\n\n.journy-settings-toggle-on {\n  background: var(--journy-blue);\n}\n\n.journy-settings-toggle-knob {\n  position: absolute;\n  top: 2px;\n  left: 2px;\n  width: 18px;\n  height: 18px;\n  border-radius: 50%;\n  background: var(--journy-surface);\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);\n  transition: transform 0.2s;\n}\n\n.journy-settings-toggle-on .journy-settings-toggle-knob {\n  transform: translateX(18px);\n}\n\n.journy-settings-item-vertical {\n  flex-direction: column;\n  align-items: flex-start;\n  gap: 6px;\n}\n\n.journy-settings-input {\n  width: 100%;\n  padding: 6px 10px;\n  border: 1px solid var(--journy-border-strong);\n  border-radius: 6px;\n  font-size: 13px;\n  color: var(--journy-text-secondary);\n  background: var(--journy-surface);\n  outline: none;\n  transition: border-color 0.2s;\n  box-sizing: border-box;\n}\n\n.journy-settings-input:focus {\n  border-color: var(--journy-blue);\n}\n\n.journy-settings-input::placeholder {\n  color: var(--journy-text-subtle);\n}\n\n.journy-settings-value {\n  font-size: 13px;\n  color: var(--journy-text-muted);\n  font-weight: 400;\n  max-width: 60%;\n  text-align: right;\n  word-break: break-all;\n}\n\n.journy-message-widget-empty {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  color: var(--journy-text-subtle);\n  font-size: 14px;\n  flex: 1;\n  min-height: 80px;\n}\n\n.journy-settings-advanced-btn {\n  background: none;\n  border: none;\n  font-size: 13px;\n  font-weight: 500;\n  color: var(--journy-text-muted);\n  cursor: pointer;\n  padding: 0;\n  transition: color 0.2s;\n}\n\n.journy-settings-advanced-btn:hover {\n  color: var(--journy-text-secondary);\n}\n\n.journy-settings-footer {\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n  padding: 12px 16px;\n  background: var(--journy-surface-alt);\n  border-top: 1px solid var(--journy-border);\n  flex-shrink: 0;\n}\n\n.journy-settings-btn {\n  padding: 6px 16px;\n  border-radius: 6px;\n  font-size: 13px;\n  font-weight: 500;\n  cursor: pointer;\n  border: 1px solid transparent;\n  transition: background-color 0.2s, border-color 0.2s, color 0.2s, opacity 0.2s;\n}\n\n.journy-settings-btn-primary {\n  background: var(--journy-blue);\n  color: var(--journy-on-header);\n}\n\n.journy-settings-btn-primary:hover:not(:disabled) {\n  background: var(--journy-blue-hover);\n}\n\n.journy-settings-btn-primary:disabled {\n  opacity: 0.5;\n  cursor: not-allowed;\n}\n\n.journy-settings-btn-secondary {\n  background: var(--journy-surface);\n  color: var(--journy-text-secondary);\n  border-color: var(--journy-border-strong);\n}\n\n.journy-settings-btn-secondary:hover {\n  background: var(--journy-surface-hover);\n}\n\n/* ============================================================\n   Banner Mode\n   ============================================================ */\n.journy-message-banner {\n  position: fixed;\n  z-index: 10000;\n  display: flex;\n  align-items: flex-start;\n  gap: 12px;\n  padding: 36px 36px 16px 16px;\n  background: var(--journy-navy);\n  color: var(--journy-on-header);\n  border-radius: 10px;\n  box-shadow: var(--journy-shadow-md);\n  box-sizing: border-box;\n  /* `width: max-content` makes the banner ask for its unwrapped natural width\n     on first layout (Chrome otherwise under-sizes shrink-to-fit flex containers\n     positioned with `left: 50%; transform: translateX(-50%)` until a re-render).\n     `max-width: 80vw` then clamps long-form content; short messages still\n     shrink to fit because max-content is below the cap. */\n  width: max-content;\n  max-width: 80vw;\n  max-height: 50vh;\n  font-size: 14px;\n  line-height: 1.4;\n  opacity: 1;\n  transition: opacity 200ms ease-out;\n  user-select: none;\n  cursor: grab;\n}\n\n.journy-message-banner:active {\n  cursor: grabbing;\n}\n\n.journy-message-banner.journy-message-banner-exiting {\n  opacity: 0;\n  pointer-events: none;\n}\n\n.journy-message-banner.journy-message-banner-pinned {\n  box-shadow: 0 0 0 2px var(--journy-blue), var(--journy-shadow-md);\n}\n\n.journy-message-banner-pin {\n  position: absolute;\n  top: 8px;\n  left: 8px;\n  font-size: 14px;\n  line-height: 1;\n  pointer-events: none;\n  opacity: 0.85;\n}\n\n.journy-message-banner .journy-message-content {\n  margin: 0;\n  font-size: 14px;\n  color: var(--journy-on-header);\n  overflow-wrap: anywhere;\n  word-break: break-word;\n}\n\n.journy-message-banner .journy-message-content img {\n  display: block;\n  max-width: 100%;\n  height: auto;\n  object-fit: contain;\n  border-radius: 4px;\n  margin: 8px 0;\n}\n\n/* Headings, paragraphs, list items, etc. inside the message HTML default to\n   dark text via the popup-scoped rules — force them to the on-header palette\n   when rendered on the navy banner background so the content stays legible. */\n.journy-message-banner .journy-message-content,\n.journy-message-banner .journy-message-content h1,\n.journy-message-banner .journy-message-content h2,\n.journy-message-banner .journy-message-content h3,\n.journy-message-banner .journy-message-content h4,\n.journy-message-banner .journy-message-content h5,\n.journy-message-banner .journy-message-content h6,\n.journy-message-banner .journy-message-content p,\n.journy-message-banner .journy-message-content li,\n.journy-message-banner .journy-message-content strong,\n.journy-message-banner .journy-message-content em,\n.journy-message-banner .journy-message-content u,\n.journy-message-banner .journy-message-content s {\n  color: var(--journy-on-header);\n}\n\n.journy-message-banner .journy-message-content blockquote {\n  color: var(--journy-on-header-muted);\n  border-left-color: var(--journy-on-header-btn-hover);\n}\n\n.journy-message-banner .journy-message-content code {\n  color: var(--journy-on-header);\n  background-color: var(--journy-on-header-btn-hover);\n}\n\n.journy-message-banner .journy-message-content pre {\n  background-color: rgba(0, 0, 0, 0.25);\n  color: var(--journy-on-header);\n  max-width: 100%;\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n  word-break: break-word;\n  overflow-x: hidden;\n}\n\n.journy-message-banner .journy-message-content table {\n  display: block;\n  max-width: 100%;\n  overflow-x: hidden;\n}\n\n.journy-message-banner .journy-message-content a {\n  color: var(--journy-on-header);\n  text-decoration: underline;\n}\n\n.journy-message-banner .journy-message-content a:hover {\n  color: var(--journy-on-header-muted);\n}\n\n.journy-message-banner .journy-message-timestamp {\n  font-size: 11px;\n  color: var(--journy-on-header-muted);\n  margin-top: 2px;\n}\n\n.journy-message-banner-content {\n  flex: 1;\n  min-width: 0;\n  cursor: pointer;\n  overflow-y: auto;\n  overflow-x: hidden;\n  max-height: calc(50vh - 52px);\n  scrollbar-width: thin;\n  scrollbar-color: var(--journy-on-header-btn) transparent;\n}\n\n.journy-message-banner-content::-webkit-scrollbar {\n  width: 8px;\n  height: 8px;\n}\n\n.journy-message-banner-content::-webkit-scrollbar-track {\n  background: transparent;\n}\n\n.journy-message-banner-content::-webkit-scrollbar-thumb {\n  background-color: var(--journy-on-header-btn-hover);\n  border-radius: 4px;\n  border: 2px solid transparent;\n  background-clip: padding-box;\n}\n\n.journy-message-banner-content::-webkit-scrollbar-thumb:hover {\n  background-color: var(--journy-on-header-btn);\n}\n\n.journy-message-banner-close {\n  position: absolute;\n  top: 6px;\n  right: 6px;\n  flex-shrink: 0;\n  background: none;\n  border: none;\n  font-size: 20px;\n  line-height: 1;\n  cursor: pointer;\n  color: var(--journy-on-header-btn);\n  padding: 4px 8px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n}\n\n.journy-message-banner-close:hover {\n  background-color: var(--journy-on-header-btn-hover);\n  color: var(--journy-on-header);\n}\n\n/* Position modifiers — animate opacity only so the static transform\n   (centering) isn't fought by the keyframe. */\n.journy-message-banner-top-left,\n.journy-message-banner-top-center,\n.journy-message-banner-top-right,\n.journy-message-banner-bottom-left,\n.journy-message-banner-bottom-center,\n.journy-message-banner-bottom-right {\n  animation: journy-banner-fade-in 0.25s ease-out;\n}\n\n.journy-message-banner-top-left    { top: 16px;    left: 16px; }\n.journy-message-banner-top-right   { top: 16px;    right: 16px; }\n.journy-message-banner-bottom-left { bottom: 16px; left: 16px; }\n.journy-message-banner-bottom-right{ bottom: 16px; right: 16px; }\n\n.journy-message-banner-top-center {\n  top: 16px;\n  left: 50%;\n  transform: translateX(-50%);\n}\n\n.journy-message-banner-bottom-center {\n  bottom: 16px;\n  left: 50%;\n  transform: translateX(-50%);\n}\n\n@keyframes journy-banner-fade-in {\n  from { opacity: 0; }\n  to   { opacity: 1; }\n}\n\n/* Debug-only settings host — keeps the SettingsPanel reachable in banner mode\n   where the widget shell (and its gear button) is not rendered. The explicit\n   height is required because the panel inside uses `position: absolute; inset: 0`\n   and would otherwise collapse to zero, hiding the panel content under\n   `overflow: hidden`. The host itself stays click-through so it doesn't\n   block the page when the panel is closed. */\n.journy-banner-settings-host {\n  position: fixed;\n  bottom: 16px;\n  right: 16px;\n  width: 320px;\n  height: min(560px, calc(100vh - 32px));\n  z-index: 10001;\n  background: transparent;\n  pointer-events: none;\n}\n\n.journy-banner-settings-host .journy-settings-panel {\n  pointer-events: auto;\n  position: absolute;\n  inset: 0;\n  background: var(--journy-surface);\n  border-radius: 12px;\n  box-shadow: var(--journy-shadow-md);\n  overflow: hidden;\n}\n\n.journy-banner-settings-trigger {\n  pointer-events: auto;\n  position: absolute;\n  bottom: 0;\n  right: 0;\n  width: 40px;\n  height: 40px;\n  border: none;\n  border-radius: 50%;\n  background: var(--journy-navy);\n  color: var(--journy-on-header);\n  font-size: 20px;\n  line-height: 1;\n  cursor: pointer;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  box-shadow: var(--journy-shadow-sm);\n  transition: background-color 0.2s, transform 0.2s;\n}\n\n.journy-banner-settings-trigger:hover {\n  background: var(--journy-blue);\n  transform: scale(1.05);\n}\n\n/* ============================================================\n   Responsive\n   ============================================================ */\n@media (max-width: 640px) {\n  .journy-message-widget {\n    min-width: calc(100vw - 32px);\n    max-width: calc(100vw - 32px);\n    left: 16px !important;\n    right: 16px !important;\n  }\n\n  .journy-message-popup {\n    width: 95%;\n    padding: 20px;\n  }\n\n  .journy-message-title {\n    font-size: 18px;\n  }\n\n  .journy-message-content {\n    font-size: 14px;\n  }\n\n  .journy-message-actions {\n    flex-direction: column;\n  }\n\n  .journy-message-action {\n    width: 100%;\n  }\n}\n";

    /**
     * Builds a generic track batch item for any SDK event type.
     */
    function buildTrackEventPayload(scope, identity, event, properties) {
        const base = {
            type: "track",
            event: event,
            properties,
        };
        if (scope === "account" && identity.accountId) {
            return {
                ...base,
                anonymousId: identity.accountId,
                context: { groupId: identity.accountId },
            };
        }
        if (identity.userId) {
            return { ...base, userId: identity.userId };
        }
        if (identity.anonymousId) {
            return { ...base, anonymousId: identity.anonymousId };
        }
        throw new Error("User scope requires userId or anonymousId; account scope requires accountId.");
    }

    const SEND_ANALYTICS_PATH = "/frontend/v1/b";
    class AnalyticsClient {
        constructor(config) {
            this.config = config;
            this.analyticsHost = config.apiEndpoint || DEFAULT_API_ENDPOINT;
        }
        get trackIdentity() {
            return {
                userId: this.config.userId,
                accountId: this.config.accountId,
            };
        }
        /**
         * General-purpose method: send an array of SDK events in a single batch.
         */
        async trackEvents(events) {
            if (events.length === 0)
                return true;
            const batch = events.map(({ event, properties }) => buildTrackEventPayload(this.config.entityType, this.trackIdentity, event, properties));
            await fetch(this.analyticsHost + SEND_ANALYTICS_PATH, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ writeKey: this.config.writeKey, batch }),
            });
            return true;
        }
        /**
         * Convenience method for "message received" events. Calls trackEvents internally.
         */
        async sendAnalyticsEvents(messageIds) {
            return this.trackEvents(messageIds.map(messageId => ({
                event: SDKEventType.MessageReceived,
                properties: { messageId },
            })));
        }
    }

    function createDebugMessages(entityType) {
        const now = new Date().toISOString();
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        return [
            {
                id: 'debug-msg-1',
                appId: 'debug',
                status: 'sent',
                scope: entityType,
                message: '<h3>Please read you lorem:</h3><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Proin tortor purus platea sit eu id nisi litora libero. Neque vulputate consequat ac amet augue blandit maximus aliquet congue. Pharetra vestibulum posuere ornare faucibus fusce dictumst orci aenean eu facilisis ut volutpat commodo senectus purus himenaeos fames primis convallis nisi.</p>',
                received: false,
                expired: false,
                createdAt: now,
            },
            {
                id: 'debug-msg-2',
                appId: 'debug',
                status: 'sent',
                scope: entityType,
                message: '<h3>Phasellus fermentum malesuada phasellus netus dictum aenean placerat egestas amet. Ornare taciti semper dolor tristique morbi. Sem leo tincidunt aliquet semper eu lectus scelerisque quis. Sagittis vivamus mollis nisi mollis enim fermentum laoreet.</h3><p>Hi ,</p><p>Curabitur semper venenatis lectus viverra ex dictumst nulla maximus. Primis elementum conubia feugiat venenatis dolor augue ac blandit nullam ac phasellus turpis feugiat mollis. Duis lectus porta mattis imperdiet vivamus Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Proin tortor purus platea sit accumsan nec elit eras fuctus primis ipsum gravida class conguet eu id nisi litora libero. Neque vulputate consequat ac amet augue blandit maximus aliquet congue. Pharetra vestibulum posuere ornare faucibus fusce dictumst orci aenean eu facilisis ut volutpat commodo senectus purus himenaeos fames primis convallis nisi.</p>',
                received: true,
                expired: false,
                createdAt: fiveMinAgo,
            },
            {
                id: 'debug-msg-3',
                appId: 'debug',
                status: 'sent',
                scope: entityType,
                message: '<h3>Phasellus fermentum malesuada phasellus netus dictum aenean placerat egestas amet. Ornare taciti semper dolor tristique morbi. Sem leo tincidunt aliquet semper eu lectus</h3><p>Hi ,</p><p>Curabitur semper venenatis lectus viverra ex dictumst nulla maximus. Primis elementum conubia feugiat venenatis dolor augue ac blandit nullam ac phasellus turpis feugiat mollis.</p>',
                received: true,
                expired: false,
                createdAt: fiveMinAgo,
            },
            {
                id: 'debug-msg-4',
                appId: 'debug',
                status: 'sent',
                scope: entityType,
                message: '<h3>Second Message</h3><p>Use this to test <a href="https://example.com">links</a>, navigation, and layout.</p>',
                received: true,
                expired: false,
                createdAt: fiveMinAgo,
            },
            {
                id: 'debug-msg-banner-1-short',
                appId: 'debug',
                status: 'sent',
                scope: entityType,
                message: '<p><strong>Quick note:</strong> short banner — smallest visual baseline. Drag me around to reposition.</p>',
                isBanner: true,
                received: false,
                expired: false,
                createdAt: fiveMinAgo,
            },
            {
                id: 'debug-msg-banner-2-link-image',
                appId: 'debug',
                status: 'sent',
                scope: entityType,
                message: '<p><strong>Heads up!</strong> Banner with a <a href="https://example.com">link</a> and an inline image — clicking the link should not toggle pin.</p>' +
                    '<p><img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MCIgaGVpZ2h0PSI4MCI+PHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjNTI4YWZhIi8+PHRleHQgeD0iNDAiIHk9IjQ1IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSJ3aGl0ZSIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTQiPmJhbm5lcjwvdGV4dD48L3N2Zz4=" alt="banner illustration" /></p>',
                isBanner: true,
                received: false,
                expired: false,
                createdAt: now,
            },
            {
                id: 'debug-msg-banner-3-long',
                appId: 'debug',
                status: 'sent',
                scope: entityType,
                message: `
        <h4>Long banner — pin me, then scroll</h4>
        <p>Click anywhere in the body to pin (auto-dismiss timer pauses). Scroll the content to verify the custom scrollbar styling and that the pin/close chrome stays anchored.</p>
        <ul>
          <li>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</li>
          <li>Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</li>
          <li>Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</li>
          <li>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum.</li>
        </ul>
        <p>Curabitur semper venenatis lectus viverra ex dictumst nulla maximus. Primis elementum conubia feugiat venenatis dolor augue ac blandit nullam ac phasellus turpis feugiat mollis.</p>
        <p>Phasellus fermentum malesuada phasellus netus dictum aenean placerat egestas amet. Ornare taciti semper dolor tristique morbi. Sem leo tincidunt aliquet semper eu lectus scelerisque quis.</p>
        <p>Read more at <a href="https://example.com/changelog">the changelog</a>.</p>
      `,
                isBanner: true,
                received: false,
                expired: false,
                createdAt: now,
            },
            {
                id: 'debug-msg-banner-4-wide',
                appId: 'debug',
                status: 'sent',
                scope: entityType,
                message: '<p><strong>Width test:</strong> long unbreakable token below — banner should shrink-to-fit and never trigger horizontal scroll, even on narrow viewports.</p>' +
                    '<p>https://example.com/very/long/path/abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz</p>',
                isBanner: true,
                received: false,
                expired: false,
                createdAt: now,
            },
            {
                id: 'debug-msg-banner-5-queue',
                appId: 'debug',
                status: 'sent',
                scope: entityType,
                message: '<p>Queued banner — surfaces after the previous one is dismissed. Verifies banner ordering by <code>createdAt</code>.</p>',
                isBanner: true,
                received: false,
                expired: false,
                createdAt: now,
            },
            {
                id: 'debug-msg-5-long',
                appId: 'debug',
                status: 'sent',
                scope: entityType,
                message: `
        <h3>Release notes — long-form message</h3>
        <p>This message is intentionally long so the dedicated message window has to scroll. Use it to verify that the close button stays pinned to the top of the visible area while the body is being scrolled.</p>
        <h4>Highlights</h4>
        <ul>
          <li>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</li>
          <li>Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</li>
          <li>Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</li>
          <li>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum.</li>
          <li>Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia.</li>
        </ul>
        <p>Curabitur semper venenatis lectus viverra ex dictumst nulla maximus. Primis elementum conubia feugiat venenatis dolor augue ac blandit nullam ac phasellus turpis feugiat mollis. Duis lectus porta mattis imperdiet vivamus.</p>
        <p>Pharetra vestibulum posuere ornare faucibus fusce dictumst orci aenean eu facilisis ut volutpat commodo senectus purus himenaeos fames primis convallis nisi. Neque vulputate consequat ac amet augue blandit maximus aliquet congue.</p>
        <h4>Details</h4>
        <p>Phasellus fermentum malesuada phasellus netus dictum aenean placerat egestas amet. Ornare taciti semper dolor tristique morbi. Sem leo tincidunt aliquet semper eu lectus scelerisque quis. Sagittis vivamus mollis nisi mollis enim fermentum laoreet.</p>
        <p>Proin tortor purus platea sit eu id nisi litora libero. Neque vulputate consequat ac amet augue blandit maximus aliquet congue. Pharetra vestibulum posuere ornare faucibus fusce dictumst orci aenean eu facilisis ut volutpat commodo senectus.</p>
        <p>Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia curae. Donec velit neque, auctor sit amet aliquam vel, ullamcorper sit amet ligula. Cras ultricies ligula sed magna dictum porta.</p>
        <p>Mauris blandit aliquet elit, eget tincidunt nibh pulvinar a. Vivamus suscipit tortor eget felis porttitor volutpat. Donec rutrum congue leo eget malesuada. Quisque velit nisi, pretium ut lacinia in, elementum id enim.</p>
        <p>Nulla porttitor accumsan tincidunt. Quisque velit nisi, pretium ut lacinia in, elementum id enim. Vestibulum ac diam sit amet quam vehicula elementum sed sit amet dui. Praesent sapien massa, convallis a pellentesque nec, egestas non nisi.</p>
        <p>Read more at <a href="https://example.com/changelog">our changelog</a>. Try scrolling — the × button at the top right should stay reachable the entire time.</p>
      `,
                received: true,
                expired: false,
                createdAt: now,
            },
        ];
    }

    function useMessagingStore(store) {
        const [state, setState] = React.useState(() => store.getState());
        React.useEffect(() => {
            // Sync in case state changed between render and effect
            setState(store.getState());
            return store.subscribe(() => setState(store.getState()));
        }, [store]);
        return state;
    }

    /*! @license DOMPurify 3.4.16 | (c) Cure53 and other contributors | Released under the Apache license 2.0 and Mozilla Public License 2.0 | github.com/cure53/DOMPurify/blob/3.4.16/LICENSE */
    function _arrayLikeToArray(r, a) {
    	(null == a || a > r.length) && (a = r.length);
    	for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e];
    	return n;
    }
    function _arrayWithHoles(r) {
    	if (Array.isArray(r)) return r;
    }
    function _iterableToArrayLimit(r, l) {
    	var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
    	if (null != t) {
    		var e, n, i, u, a = [], f = true, o = false;
    		try {
    			if (i = (t = t.call(r)).next, 0 === l) ; else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0);
    		} catch (r) {
    			o = true, n = r;
    		} finally {
    			try {
    				if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return;
    			} finally {
    				if (o) throw n;
    			}
    		}
    		return a;
    	}
    }
    function _nonIterableRest() {
    	throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
    }
    /*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/babel/babel/blob/main/packages/babel-helpers/LICENSE */
    function _slicedToArray(r, e) {
    	return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest();
    }
    function _unsupportedIterableToArray(r, a) {
    	if (r) {
    		if ("string" == typeof r) return _arrayLikeToArray(r, a);
    		var t = {}.toString.call(r).slice(8, -1);
    		return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0;
    	}
    }
    const entries = Object.entries;
    const setPrototypeOf = Object.setPrototypeOf;
    const isFrozen = Object.isFrozen;
    const getPrototypeOf = Object.getPrototypeOf;
    const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    let freeze = Object.freeze;
    let seal = Object.seal;
    let create = Object.create;
    let _ref = typeof Reflect !== "undefined" && Reflect;
    let apply = _ref.apply;
    let construct = _ref.construct;
    if (!freeze) freeze = function freeze(x) {
    	return x;
    };
    if (!seal) seal = function seal(x) {
    	return x;
    };
    if (!apply) apply = function apply(func, thisArg) {
    	for (var _len = arguments.length, args = new Array(_len > 2 ? _len - 2 : 0), _key = 2; _key < _len; _key++) args[_key - 2] = arguments[_key];
    	return func.apply(thisArg, args);
    };
    if (!construct) construct = function construct(Func) {
    	for (var _len2 = arguments.length, args = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) args[_key2 - 1] = arguments[_key2];
    	return new Func(...args);
    };
    const arrayForEach = unapply(Array.prototype.forEach);
    const arrayLastIndexOf = unapply(Array.prototype.lastIndexOf);
    const arrayPop = unapply(Array.prototype.pop);
    const arrayPush = unapply(Array.prototype.push);
    const arraySplice = unapply(Array.prototype.splice);
    const arrayIsArray = Array.isArray;
    const stringToLowerCase = unapply(String.prototype.toLowerCase);
    const stringToString = unapply(String.prototype.toString);
    const stringMatch = unapply(String.prototype.match);
    const stringReplace = unapply(String.prototype.replace);
    const stringIndexOf = unapply(String.prototype.indexOf);
    const stringTrim = unapply(String.prototype.trim);
    const numberToString = unapply(Number.prototype.toString);
    const booleanToString = unapply(Boolean.prototype.toString);
    const bigintToString = typeof BigInt === "undefined" ? null : unapply(BigInt.prototype.toString);
    const symbolToString = typeof Symbol === "undefined" ? null : unapply(Symbol.prototype.toString);
    const objectHasOwnProperty = unapply(Object.prototype.hasOwnProperty);
    const objectToString = unapply(Object.prototype.toString);
    const regExpTest = unapply(RegExp.prototype.test);
    const typeErrorCreate = unconstruct(TypeError);
    /**
    * Creates a new function that calls the given function with a specified thisArg and arguments.
    *
    * @param func - The function to be wrapped and called.
    * @returns A new function that calls the given function with a specified thisArg and arguments.
    */
    function unapply(func) {
    	return function(thisArg) {
    		if (thisArg instanceof RegExp) thisArg.lastIndex = 0;
    		for (var _len3 = arguments.length, args = new Array(_len3 > 1 ? _len3 - 1 : 0), _key3 = 1; _key3 < _len3; _key3++) args[_key3 - 1] = arguments[_key3];
    		return apply(func, thisArg, args);
    	};
    }
    /**
    * Creates a new function that constructs an instance of the given constructor function with the provided arguments.
    *
    * @param func - The constructor function to be wrapped and called.
    * @returns A new function that constructs an instance of the given constructor function with the provided arguments.
    */
    function unconstruct(Func) {
    	return function() {
    		for (var _len4 = arguments.length, args = new Array(_len4), _key4 = 0; _key4 < _len4; _key4++) args[_key4] = arguments[_key4];
    		return construct(Func, args);
    	};
    }
    /**
    * Add properties to a lookup table
    *
    * @param set - The set to which elements will be added.
    * @param array - The array containing elements to be added to the set.
    * @param transformCaseFunc - An optional function to transform the case of each element before adding to the set.
    * @returns The modified set with added elements.
    */
    function addToSet(set, array) {
    	let transformCaseFunc = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : stringToLowerCase;
    	if (setPrototypeOf) setPrototypeOf(set, null);
    	if (!arrayIsArray(array)) return set;
    	let l = array.length;
    	while (l--) {
    		let element = array[l];
    		if (typeof element === "string") {
    			const lcElement = transformCaseFunc(element);
    			if (lcElement !== element) {
    				if (!isFrozen(array)) array[l] = lcElement;
    				element = lcElement;
    			}
    		}
    		set[element] = true;
    	}
    	return set;
    }
    /**
    * Clean up an array to harden against CSPP
    *
    * @param array - The array to be cleaned.
    * @returns The cleaned version of the array
    */
    function cleanArray(array) {
    	for (let index = 0; index < array.length; index++) if (!objectHasOwnProperty(array, index)) array[index] = null;
    	return array;
    }
    /**
    * Shallow clone an object
    *
    * @param object - The object to be cloned.
    * @returns A new object that copies the original.
    */
    function clone(object) {
    	const newObject = create(null);
    	for (const _ref2 of entries(object)) {
    		var _ref3 = _slicedToArray(_ref2, 2);
    		const property = _ref3[0];
    		const value = _ref3[1];
    		if (objectHasOwnProperty(object, property)) {
    			if (arrayIsArray(value)) newObject[property] = cleanArray(value);
    			else if (value && typeof value === "object" && value.constructor === Object) newObject[property] = clone(value);
    			else newObject[property] = value;
    		}
    	}
    	return newObject;
    }
    /**
    * Convert non-node values into strings without depending on direct property access.
    *
    * @param value - The value to stringify.
    * @returns A string representation of the provided value.
    */
    function stringifyValue(value) {
    	switch (typeof value) {
    		case "string": return value;
    		case "number": return numberToString(value);
    		case "boolean": return booleanToString(value);
    		case "bigint": return bigintToString ? bigintToString(value) : "0";
    		case "symbol": return symbolToString ? symbolToString(value) : "Symbol()";
    		case "undefined": return objectToString(value);
    		case "function":
    		case "object": {
    			if (value === null) return objectToString(value);
    			const valueAsRecord = value;
    			const valueToString = lookupGetter(valueAsRecord, "toString");
    			if (typeof valueToString === "function") {
    				const stringified = valueToString(valueAsRecord);
    				return typeof stringified === "string" ? stringified : objectToString(stringified);
    			}
    			return objectToString(value);
    		}
    		default: return objectToString(value);
    	}
    }
    /**
    * This method automatically checks if the prop is function or getter and behaves accordingly.
    *
    * @param object - The object to look up the getter function in its prototype chain.
    * @param prop - The property name for which to find the getter function.
    * @returns The getter function found in the prototype chain or a fallback function.
    */
    function lookupGetter(object, prop) {
    	while (object !== null) {
    		const desc = getOwnPropertyDescriptor(object, prop);
    		if (desc) {
    			if (desc.get) return unapply(desc.get);
    			if (typeof desc.value === "function") return unapply(desc.value);
    		}
    		object = getPrototypeOf(object);
    	}
    	function fallbackValue() {
    		return null;
    	}
    	return fallbackValue;
    }
    function isRegex(value) {
    	try {
    		regExpTest(value, "");
    		return true;
    	} catch (_unused) {
    		return false;
    	}
    }
    const html$1 = freeze([
    	"a",
    	"abbr",
    	"acronym",
    	"address",
    	"area",
    	"article",
    	"aside",
    	"audio",
    	"b",
    	"bdi",
    	"bdo",
    	"big",
    	"blink",
    	"blockquote",
    	"body",
    	"br",
    	"button",
    	"canvas",
    	"caption",
    	"center",
    	"cite",
    	"code",
    	"col",
    	"colgroup",
    	"content",
    	"data",
    	"datalist",
    	"dd",
    	"decorator",
    	"del",
    	"details",
    	"dfn",
    	"dialog",
    	"dir",
    	"div",
    	"dl",
    	"dt",
    	"element",
    	"em",
    	"fieldset",
    	"figcaption",
    	"figure",
    	"font",
    	"footer",
    	"form",
    	"h1",
    	"h2",
    	"h3",
    	"h4",
    	"h5",
    	"h6",
    	"head",
    	"header",
    	"hgroup",
    	"hr",
    	"html",
    	"i",
    	"img",
    	"input",
    	"ins",
    	"kbd",
    	"label",
    	"legend",
    	"li",
    	"main",
    	"map",
    	"mark",
    	"marquee",
    	"menu",
    	"menuitem",
    	"meter",
    	"nav",
    	"nobr",
    	"ol",
    	"optgroup",
    	"option",
    	"output",
    	"p",
    	"picture",
    	"pre",
    	"progress",
    	"q",
    	"rp",
    	"rt",
    	"ruby",
    	"s",
    	"samp",
    	"search",
    	"section",
    	"select",
    	"shadow",
    	"slot",
    	"small",
    	"source",
    	"spacer",
    	"span",
    	"strike",
    	"strong",
    	"style",
    	"sub",
    	"summary",
    	"sup",
    	"table",
    	"tbody",
    	"td",
    	"template",
    	"textarea",
    	"tfoot",
    	"th",
    	"thead",
    	"time",
    	"tr",
    	"track",
    	"tt",
    	"u",
    	"ul",
    	"var",
    	"video",
    	"wbr"
    ]);
    const svg$1 = freeze([
    	"svg",
    	"a",
    	"altglyph",
    	"altglyphdef",
    	"altglyphitem",
    	"animatecolor",
    	"animatemotion",
    	"animatetransform",
    	"circle",
    	"clippath",
    	"defs",
    	"desc",
    	"ellipse",
    	"enterkeyhint",
    	"exportparts",
    	"filter",
    	"font",
    	"g",
    	"glyph",
    	"glyphref",
    	"hkern",
    	"image",
    	"inputmode",
    	"line",
    	"lineargradient",
    	"marker",
    	"mask",
    	"metadata",
    	"mpath",
    	"part",
    	"path",
    	"pattern",
    	"polygon",
    	"polyline",
    	"radialgradient",
    	"rect",
    	"stop",
    	"style",
    	"switch",
    	"symbol",
    	"text",
    	"textpath",
    	"title",
    	"tref",
    	"tspan",
    	"view",
    	"vkern"
    ]);
    const svgFilters = freeze([
    	"feBlend",
    	"feColorMatrix",
    	"feComponentTransfer",
    	"feComposite",
    	"feConvolveMatrix",
    	"feDiffuseLighting",
    	"feDisplacementMap",
    	"feDistantLight",
    	"feDropShadow",
    	"feFlood",
    	"feFuncA",
    	"feFuncB",
    	"feFuncG",
    	"feFuncR",
    	"feGaussianBlur",
    	"feImage",
    	"feMerge",
    	"feMergeNode",
    	"feMorphology",
    	"feOffset",
    	"fePointLight",
    	"feSpecularLighting",
    	"feSpotLight",
    	"feTile",
    	"feTurbulence"
    ]);
    const svgDisallowed = freeze([
    	"animate",
    	"color-profile",
    	"cursor",
    	"discard",
    	"font-face",
    	"font-face-format",
    	"font-face-name",
    	"font-face-src",
    	"font-face-uri",
    	"foreignobject",
    	"hatch",
    	"hatchpath",
    	"mesh",
    	"meshgradient",
    	"meshpatch",
    	"meshrow",
    	"missing-glyph",
    	"script",
    	"set",
    	"solidcolor",
    	"unknown",
    	"use"
    ]);
    const mathMl$1 = freeze([
    	"math",
    	"menclose",
    	"merror",
    	"mfenced",
    	"mfrac",
    	"mglyph",
    	"mi",
    	"mlabeledtr",
    	"mmultiscripts",
    	"mn",
    	"mo",
    	"mover",
    	"mpadded",
    	"mphantom",
    	"mroot",
    	"mrow",
    	"ms",
    	"mspace",
    	"msqrt",
    	"mstyle",
    	"msub",
    	"msup",
    	"msubsup",
    	"mtable",
    	"mtd",
    	"mtext",
    	"mtr",
    	"munder",
    	"munderover",
    	"mprescripts"
    ]);
    const mathMlDisallowed = freeze([
    	"maction",
    	"maligngroup",
    	"malignmark",
    	"mlongdiv",
    	"mscarries",
    	"mscarry",
    	"msgroup",
    	"mstack",
    	"msline",
    	"msrow",
    	"semantics",
    	"annotation",
    	"annotation-xml",
    	"mprescripts",
    	"none"
    ]);
    const text = freeze(["#text"]);
    const html = freeze([
    	"accept",
    	"action",
    	"align",
    	"alt",
    	"autocapitalize",
    	"autocomplete",
    	"autopictureinpicture",
    	"autoplay",
    	"background",
    	"bgcolor",
    	"border",
    	"capture",
    	"cellpadding",
    	"cellspacing",
    	"checked",
    	"cite",
    	"class",
    	"clear",
    	"color",
    	"cols",
    	"colspan",
    	"command",
    	"commandfor",
    	"controls",
    	"controlslist",
    	"coords",
    	"crossorigin",
    	"datetime",
    	"decoding",
    	"default",
    	"dir",
    	"disabled",
    	"disablepictureinpicture",
    	"disableremoteplayback",
    	"download",
    	"draggable",
    	"enctype",
    	"enterkeyhint",
    	"exportparts",
    	"face",
    	"for",
    	"headers",
    	"height",
    	"hidden",
    	"high",
    	"href",
    	"hreflang",
    	"id",
    	"inert",
    	"inputmode",
    	"integrity",
    	"ismap",
    	"kind",
    	"label",
    	"lang",
    	"list",
    	"loading",
    	"loop",
    	"low",
    	"max",
    	"maxlength",
    	"media",
    	"method",
    	"min",
    	"minlength",
    	"multiple",
    	"muted",
    	"name",
    	"nonce",
    	"noshade",
    	"novalidate",
    	"nowrap",
    	"open",
    	"optimum",
    	"part",
    	"pattern",
    	"placeholder",
    	"playsinline",
    	"popover",
    	"popovertarget",
    	"popovertargetaction",
    	"poster",
    	"preload",
    	"pubdate",
    	"radiogroup",
    	"readonly",
    	"rel",
    	"required",
    	"rev",
    	"reversed",
    	"role",
    	"rows",
    	"rowspan",
    	"spellcheck",
    	"scope",
    	"selected",
    	"shape",
    	"size",
    	"sizes",
    	"slot",
    	"span",
    	"srclang",
    	"start",
    	"src",
    	"srcset",
    	"step",
    	"style",
    	"summary",
    	"tabindex",
    	"title",
    	"translate",
    	"type",
    	"usemap",
    	"valign",
    	"value",
    	"width",
    	"wrap",
    	"xmlns"
    ]);
    const svg = freeze([
    	"accent-height",
    	"accumulate",
    	"additive",
    	"alignment-baseline",
    	"amplitude",
    	"ascent",
    	"attributename",
    	"attributetype",
    	"azimuth",
    	"basefrequency",
    	"baseline-shift",
    	"begin",
    	"bias",
    	"by",
    	"class",
    	"clip",
    	"clippathunits",
    	"clip-path",
    	"clip-rule",
    	"color",
    	"color-interpolation",
    	"color-interpolation-filters",
    	"color-profile",
    	"color-rendering",
    	"cx",
    	"cy",
    	"d",
    	"dx",
    	"dy",
    	"diffuseconstant",
    	"direction",
    	"display",
    	"divisor",
    	"dominant-baseline",
    	"dur",
    	"edgemode",
    	"elevation",
    	"end",
    	"exponent",
    	"fill",
    	"fill-opacity",
    	"fill-rule",
    	"filter",
    	"filterunits",
    	"flood-color",
    	"flood-opacity",
    	"font-family",
    	"font-size",
    	"font-size-adjust",
    	"font-stretch",
    	"font-style",
    	"font-variant",
    	"font-weight",
    	"fx",
    	"fy",
    	"g1",
    	"g2",
    	"glyph-name",
    	"glyphref",
    	"gradientunits",
    	"gradienttransform",
    	"height",
    	"href",
    	"id",
    	"image-rendering",
    	"in",
    	"in2",
    	"intercept",
    	"k",
    	"k1",
    	"k2",
    	"k3",
    	"k4",
    	"kerning",
    	"keypoints",
    	"keysplines",
    	"keytimes",
    	"lang",
    	"lengthadjust",
    	"letter-spacing",
    	"kernelmatrix",
    	"kernelunitlength",
    	"lighting-color",
    	"local",
    	"marker-end",
    	"marker-mid",
    	"marker-start",
    	"markerheight",
    	"markerunits",
    	"markerwidth",
    	"maskcontentunits",
    	"maskunits",
    	"max",
    	"mask",
    	"mask-type",
    	"media",
    	"method",
    	"mode",
    	"min",
    	"name",
    	"numoctaves",
    	"offset",
    	"operator",
    	"opacity",
    	"order",
    	"orient",
    	"orientation",
    	"origin",
    	"overflow",
    	"paint-order",
    	"path",
    	"pathlength",
    	"patterncontentunits",
    	"patterntransform",
    	"patternunits",
    	"pointer-events",
    	"points",
    	"preservealpha",
    	"preserveaspectratio",
    	"primitiveunits",
    	"r",
    	"rx",
    	"ry",
    	"radius",
    	"refx",
    	"refy",
    	"repeatcount",
    	"repeatdur",
    	"restart",
    	"result",
    	"rotate",
    	"scale",
    	"seed",
    	"shape-rendering",
    	"slope",
    	"specularconstant",
    	"specularexponent",
    	"spreadmethod",
    	"startoffset",
    	"stddeviation",
    	"stitchtiles",
    	"stop-color",
    	"stop-opacity",
    	"stroke-dasharray",
    	"stroke-dashoffset",
    	"stroke-linecap",
    	"stroke-linejoin",
    	"stroke-miterlimit",
    	"stroke-opacity",
    	"stroke",
    	"stroke-width",
    	"style",
    	"surfacescale",
    	"systemlanguage",
    	"tabindex",
    	"tablevalues",
    	"targetx",
    	"targety",
    	"transform",
    	"transform-origin",
    	"text-anchor",
    	"text-decoration",
    	"text-orientation",
    	"text-rendering",
    	"textlength",
    	"type",
    	"u1",
    	"u2",
    	"unicode",
    	"values",
    	"vector-effect",
    	"viewbox",
    	"visibility",
    	"version",
    	"vert-adv-y",
    	"vert-origin-x",
    	"vert-origin-y",
    	"width",
    	"word-spacing",
    	"wrap",
    	"writing-mode",
    	"xchannelselector",
    	"ychannelselector",
    	"x",
    	"x1",
    	"x2",
    	"xmlns",
    	"y",
    	"y1",
    	"y2",
    	"z",
    	"zoomandpan"
    ]);
    const mathMl = freeze([
    	"accent",
    	"accentunder",
    	"align",
    	"bevelled",
    	"close",
    	"columnalign",
    	"columnlines",
    	"columnspacing",
    	"columnspan",
    	"denomalign",
    	"depth",
    	"dir",
    	"display",
    	"displaystyle",
    	"encoding",
    	"fence",
    	"frame",
    	"height",
    	"href",
    	"id",
    	"largeop",
    	"length",
    	"linethickness",
    	"lquote",
    	"lspace",
    	"mathbackground",
    	"mathcolor",
    	"mathsize",
    	"mathvariant",
    	"maxsize",
    	"minsize",
    	"movablelimits",
    	"notation",
    	"numalign",
    	"open",
    	"rowalign",
    	"rowlines",
    	"rowspacing",
    	"rowspan",
    	"rspace",
    	"rquote",
    	"scriptlevel",
    	"scriptminsize",
    	"scriptsizemultiplier",
    	"selection",
    	"separator",
    	"separators",
    	"stretchy",
    	"subscriptshift",
    	"supscriptshift",
    	"symmetric",
    	"voffset",
    	"width",
    	"xmlns"
    ]);
    const xml = freeze([
    	"xlink:href",
    	"xml:id",
    	"xlink:title",
    	"xml:space",
    	"xmlns:xlink"
    ]);
    const MUSTACHE_EXPR = seal(/{{[\w\W]*|^[\w\W]*}}/g);
    const ERB_EXPR = seal(/<%[\w\W]*|^[\w\W]*%>/g);
    const TMPLIT_EXPR = seal(/\${[\w\W]*/g);
    const DATA_ATTR = seal(/^data-[\-\w.\u00B7-\uFFFF]+$/);
    const ARIA_ATTR = seal(/^aria-[\-\w]+$/);
    const IS_ALLOWED_URI = seal(/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i);
    const IS_SCRIPT_OR_DATA = seal(/^(?:\w+script|data):/i);
    const ATTR_WHITESPACE = seal(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g);
    const DOCTYPE_NAME = seal(/^html$/i);
    const CUSTOM_ELEMENT = seal(/^[a-z][.\w]*(-[.\w]+)+$/i);
    const ELEMENT_MARKUP_PROBE = seal(/<[/\w!]/g);
    const COMMENT_MARKUP_PROBE = seal(/<[/\w]/g);
    const FALLBACK_TAG_CLOSE = seal(/<\/no(script|embed|frames)/i);
    const SELF_CLOSING_TAG = seal(/\/>/i);
    const NODE_TYPE = {
    	element: 1,
    	attribute: 2,
    	text: 3,
    	cdataSection: 4,
    	entityReference: 5,
    	entityNode: 6,
    	processingInstruction: 7,
    	comment: 8,
    	document: 9,
    	documentType: 10,
    	documentFragment: 11,
    	notation: 12
    };
    const LITERAL_TEXT_ELEMENT_NAMES = [
    	"style",
    	"script",
    	"xmp",
    	"iframe",
    	"noembed",
    	"noframes",
    	"plaintext",
    	"noscript"
    ];
    const LITERAL_TEXT_ELEMENTS = freeze(addToSet({}, LITERAL_TEXT_ELEMENT_NAMES));
    const LITERAL_TEXT_CLOSE = function() {
    	const map = {};
    	arrayForEach(LITERAL_TEXT_ELEMENT_NAMES, (name) => {
    		map[name] = seal(new RegExp("</" + name + "(?=[\\t\\n\\f\\r />])", "i"));
    	});
    	return freeze(map);
    }();
    const getGlobal = function getGlobal() {
    	return typeof window === "undefined" ? null : window;
    };
    /**
    * Creates a no-op policy for internal use only.
    * Don't export this function outside this module!
    * @param trustedTypes The policy factory.
    * @param purifyHostElement The Script element used to load DOMPurify (to determine policy name suffix).
    * @return The policy created (or null, if Trusted Types
    * are not supported or creating the policy failed).
    */
    const _createTrustedTypesPolicy = function _createTrustedTypesPolicy(trustedTypes, purifyHostElement) {
    	if (typeof trustedTypes !== "object" || typeof trustedTypes.createPolicy !== "function") return null;
    	let suffix = null;
    	const ATTR_NAME = "data-tt-policy-suffix";
    	if (purifyHostElement && purifyHostElement.hasAttribute(ATTR_NAME)) suffix = purifyHostElement.getAttribute(ATTR_NAME);
    	const policyName = "dompurify" + (suffix ? "#" + suffix : "");
    	try {
    		return trustedTypes.createPolicy(policyName, {
    			createHTML(html) {
    				return html;
    			},
    			createScriptURL(scriptUrl) {
    				return scriptUrl;
    			}
    		});
    	} catch (_) {
    		console.warn("TrustedTypes policy " + policyName + " could not be created.");
    		return null;
    	}
    };
    const _createHooksMap = function _createHooksMap() {
    	return {
    		afterSanitizeAttributes: [],
    		afterSanitizeElements: [],
    		afterSanitizeShadowDOM: [],
    		beforeSanitizeAttributes: [],
    		beforeSanitizeElements: [],
    		beforeSanitizeShadowDOM: [],
    		uponSanitizeAttribute: [],
    		uponSanitizeElement: [],
    		uponSanitizeShadowNode: []
    	};
    };
    /**
    * Resolve a set-valued configuration option: a fresh set built from
    * cfg[key] when it is an own array property (seeded with a clone of
    * options.base when given, case-normalized via options.transform),
    * the fallback set otherwise.
    *
    * @param cfg the cloned, prototype-free configuration object
    * @param key the configuration property to read
    * @param fallback the set to use when the option is absent or not an array
    * @param options transform and optional base set to merge into
    * @returns the resolved set
    */
    const _resolveSetOption = function _resolveSetOption(cfg, key, fallback, options) {
    	return objectHasOwnProperty(cfg, key) && arrayIsArray(cfg[key]) ? addToSet(options.base ? clone(options.base) : {}, cfg[key], options.transform) : fallback;
    };
    /**
    * Resolve an object-valued configuration option: a prototype-free clone
    * of cfg[key] when it is an own, truthy object property, else a fresh
    * fallback built by makeFallback (fresh on every parse, so a previous
    * parse can never leak state into the next one).
    *
    * @param cfg the cloned, prototype-free configuration object
    * @param key the configuration property to read
    * @param makeFallback builds the fallback value when the option is absent
    * @returns the resolved object
    */
    const _resolveObjectOption = function _resolveObjectOption(cfg, key, makeFallback) {
    	const value = objectHasOwnProperty(cfg, key) ? cfg[key] : void 0;
    	return value && typeof value === "object" ? clone(value) : makeFallback();
    };
    function createDOMPurify() {
    	let window = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : getGlobal();
    	const DOMPurify = (root) => createDOMPurify(root);
    	DOMPurify.version = "3.4.16";
    	DOMPurify.removed = [];
    	if (!window || !window.document || window.document.nodeType !== NODE_TYPE.document || !window.Element) {
    		DOMPurify.isSupported = false;
    		return DOMPurify;
    	}
    	let document = window.document;
    	const originalDocument = document;
    	const currentScript = originalDocument.currentScript;
    	window.DocumentFragment;
    	const HTMLTemplateElement = window.HTMLTemplateElement, Node = window.Node, Element = window.Element, NodeFilter = window.NodeFilter;
    	window.NamedNodeMap === void 0 && (window.NamedNodeMap || window.MozNamedAttrMap);
    	window.HTMLFormElement;
    	const DOMParser = window.DOMParser, trustedTypes = window.trustedTypes;
    	const ElementPrototype = Element.prototype;
    	const cloneNode = lookupGetter(ElementPrototype, "cloneNode");
    	const remove = lookupGetter(ElementPrototype, "remove");
    	const removeAttributeNode = lookupGetter(ElementPrototype, "removeAttributeNode");
    	const getNextSibling = lookupGetter(ElementPrototype, "nextSibling");
    	const getChildNodes = lookupGetter(ElementPrototype, "childNodes");
    	const getParentNode = lookupGetter(ElementPrototype, "parentNode");
    	const getShadowRoot = lookupGetter(ElementPrototype, "shadowRoot");
    	const getAttributes = lookupGetter(ElementPrototype, "attributes");
    	const getNodeType = Node && Node.prototype ? lookupGetter(Node.prototype, "nodeType") : null;
    	const getNodeName = Node && Node.prototype ? lookupGetter(Node.prototype, "nodeName") : null;
    	const getOwnerDocument = Node && Node.prototype ? lookupGetter(Node.prototype, "ownerDocument") : null;
    	const _readNodeType = function _readNodeType(node) {
    		return getNodeType ? getNodeType(node) : node.nodeType;
    	};
    	const _readNodeName = function _readNodeName(node) {
    		return getNodeName ? getNodeName(node) : node.nodeName;
    	};
    	if (typeof HTMLTemplateElement === "function") {
    		const template = document.createElement("template");
    		if (template.content && template.content.ownerDocument) document = template.content.ownerDocument;
    	}
    	let trustedTypesPolicy;
    	let emptyHTML = "";
    	let defaultTrustedTypesPolicy;
    	let defaultTrustedTypesPolicyResolved = false;
    	let IN_TRUSTED_TYPES_POLICY = 0;
    	const _assertNotInTrustedTypesPolicy = function _assertNotInTrustedTypesPolicy() {
    		if (IN_TRUSTED_TYPES_POLICY > 0) throw typeErrorCreate("A configured TRUSTED_TYPES_POLICY callback (createHTML or createScriptURL) must not call DOMPurify.sanitize, as that causes infinite recursion. Do not pass a policy whose callbacks wrap DOMPurify as TRUSTED_TYPES_POLICY; see the \"DOMPurify and Trusted Types\" section of the README.");
    	};
    	const _createTrustedHTML = function _createTrustedHTML(html) {
    		_assertNotInTrustedTypesPolicy();
    		IN_TRUSTED_TYPES_POLICY++;
    		try {
    			return trustedTypesPolicy.createHTML(html);
    		} finally {
    			IN_TRUSTED_TYPES_POLICY--;
    		}
    	};
    	const _createTrustedScriptURL = function _createTrustedScriptURL(scriptUrl) {
    		_assertNotInTrustedTypesPolicy();
    		IN_TRUSTED_TYPES_POLICY++;
    		try {
    			return trustedTypesPolicy.createScriptURL(scriptUrl);
    		} finally {
    			IN_TRUSTED_TYPES_POLICY--;
    		}
    	};
    	const _getDefaultTrustedTypesPolicy = function _getDefaultTrustedTypesPolicy() {
    		if (!defaultTrustedTypesPolicyResolved) {
    			defaultTrustedTypesPolicy = _createTrustedTypesPolicy(trustedTypes, currentScript);
    			defaultTrustedTypesPolicyResolved = true;
    		}
    		return defaultTrustedTypesPolicy;
    	};
    	const _document = document, implementation = _document.implementation, createNodeIterator = _document.createNodeIterator, createDocumentFragment = _document.createDocumentFragment, getElementsByTagName = _document.getElementsByTagName;
    	const importNode = originalDocument.importNode;
    	let hooks = _createHooksMap();
    	/**
    	* Expose whether this browser supports running the full DOMPurify.
    	*/
    	DOMPurify.isSupported = typeof entries === "function" && typeof getParentNode === "function" && implementation && implementation.createHTMLDocument !== void 0;
    	const MUSTACHE_EXPR$1 = MUSTACHE_EXPR, ERB_EXPR$1 = ERB_EXPR, TMPLIT_EXPR$1 = TMPLIT_EXPR, DATA_ATTR$1 = DATA_ATTR, ARIA_ATTR$1 = ARIA_ATTR, IS_SCRIPT_OR_DATA$1 = IS_SCRIPT_OR_DATA, ATTR_WHITESPACE$1 = ATTR_WHITESPACE, CUSTOM_ELEMENT$1 = CUSTOM_ELEMENT;
    	let IS_ALLOWED_URI$1 = IS_ALLOWED_URI;
    	/**
    	* We consider the elements and attributes below to be safe. Ideally
    	* don't add any new ones but feel free to remove unwanted ones.
    	*/
    	let ALLOWED_TAGS = null;
    	const DEFAULT_ALLOWED_TAGS = addToSet({}, [
    		...html$1,
    		...svg$1,
    		...svgFilters,
    		...mathMl$1,
    		...text
    	]);
    	let ALLOWED_ATTR = null;
    	const DEFAULT_ALLOWED_ATTR = addToSet({}, [
    		...html,
    		...svg,
    		...mathMl,
    		...xml
    	]);
    	let CUSTOM_ELEMENT_HANDLING = Object.seal(create(null, {
    		tagNameCheck: {
    			writable: true,
    			configurable: false,
    			enumerable: true,
    			value: null
    		},
    		attributeNameCheck: {
    			writable: true,
    			configurable: false,
    			enumerable: true,
    			value: null
    		},
    		allowCustomizedBuiltInElements: {
    			writable: true,
    			configurable: false,
    			enumerable: true,
    			value: false
    		}
    	}));
    	let FORBID_TAGS = null;
    	let FORBID_ATTR = null;
    	const EXTRA_ELEMENT_HANDLING = Object.seal(create(null, {
    		tagCheck: {
    			writable: true,
    			configurable: false,
    			enumerable: true,
    			value: null
    		},
    		attributeCheck: {
    			writable: true,
    			configurable: false,
    			enumerable: true,
    			value: null
    		}
    	}));
    	let ALLOW_ARIA_ATTR = true;
    	let ALLOW_DATA_ATTR = true;
    	let ALLOW_UNKNOWN_PROTOCOLS = false;
    	let ALLOW_SELF_CLOSE_IN_ATTR = true;
    	let SAFE_FOR_TEMPLATES = false;
    	let SAFE_FOR_XML = true;
    	let WHOLE_DOCUMENT = false;
    	let SET_CONFIG = false;
    	let SET_CONFIG_ALLOWED_TAGS = null;
    	let SET_CONFIG_ALLOWED_ATTR = null;
    	let FORCE_BODY = false;
    	let RETURN_DOM = false;
    	let RETURN_DOM_FRAGMENT = false;
    	let RETURN_TRUSTED_TYPE = false;
    	let SANITIZE_DOM = true;
    	let SANITIZE_NAMED_PROPS = false;
    	const SANITIZE_NAMED_PROPS_PREFIX = "user-content-";
    	let KEEP_CONTENT = true;
    	let IN_PLACE = false;
    	let USE_PROFILES = {};
    	let FORBID_CONTENTS = null;
    	const DEFAULT_FORBID_CONTENTS = addToSet({}, [
    		"annotation-xml",
    		"audio",
    		"colgroup",
    		"desc",
    		"foreignobject",
    		"head",
    		"iframe",
    		"math",
    		"mi",
    		"mn",
    		"mo",
    		"ms",
    		"mtext",
    		"noembed",
    		"noframes",
    		"noscript",
    		"plaintext",
    		"script",
    		"selectedcontent",
    		"style",
    		"svg",
    		"template",
    		"thead",
    		"title",
    		"video",
    		"xmp"
    	]);
    	let DATA_URI_TAGS = null;
    	const DEFAULT_DATA_URI_TAGS = addToSet({}, [
    		"audio",
    		"video",
    		"img",
    		"source",
    		"image",
    		"track"
    	]);
    	let URI_SAFE_ATTRIBUTES = null;
    	const DEFAULT_URI_SAFE_ATTRIBUTES = addToSet({}, [
    		"alt",
    		"class",
    		"for",
    		"id",
    		"label",
    		"name",
    		"pattern",
    		"placeholder",
    		"role",
    		"summary",
    		"title",
    		"value",
    		"style",
    		"xmlns"
    	]);
    	const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
    	const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
    	const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
    	let NAMESPACE = HTML_NAMESPACE;
    	let IS_EMPTY_INPUT = false;
    	let ALLOWED_NAMESPACES = null;
    	const DEFAULT_ALLOWED_NAMESPACES = addToSet({}, [
    		MATHML_NAMESPACE,
    		SVG_NAMESPACE,
    		HTML_NAMESPACE
    	], stringToString);
    	const DEFAULT_MATHML_TEXT_INTEGRATION_POINTS = freeze([
    		"mi",
    		"mo",
    		"mn",
    		"ms",
    		"mtext"
    	]);
    	let MATHML_TEXT_INTEGRATION_POINTS = addToSet({}, DEFAULT_MATHML_TEXT_INTEGRATION_POINTS);
    	const DEFAULT_HTML_INTEGRATION_POINTS = freeze(["annotation-xml"]);
    	let HTML_INTEGRATION_POINTS = addToSet({}, DEFAULT_HTML_INTEGRATION_POINTS);
    	const COMMON_SVG_AND_HTML_ELEMENTS = addToSet({}, [
    		"title",
    		"style",
    		"font",
    		"a",
    		"script"
    	]);
    	let PARSER_MEDIA_TYPE = null;
    	const SUPPORTED_PARSER_MEDIA_TYPES = ["application/xhtml+xml", "text/html"];
    	const DEFAULT_PARSER_MEDIA_TYPE = "text/html";
    	let transformCaseFunc = null;
    	let CONFIG = null;
    	const formElement = document.createElement("form");
    	const isRegexOrFunction = function isRegexOrFunction(testValue) {
    		return testValue instanceof RegExp || testValue instanceof Function;
    	};
    	/**
    	* _parseConfig
    	*
    	* @param cfg optional config literal
    	*/
    	const _parseConfig = function _parseConfig() {
    		let cfg = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    		if (CONFIG && CONFIG === cfg) return;
    		if (!cfg || typeof cfg !== "object") cfg = {};
    		cfg = clone(cfg);
    		PARSER_MEDIA_TYPE = SUPPORTED_PARSER_MEDIA_TYPES.indexOf(cfg.PARSER_MEDIA_TYPE) === -1 ? DEFAULT_PARSER_MEDIA_TYPE : cfg.PARSER_MEDIA_TYPE;
    		transformCaseFunc = PARSER_MEDIA_TYPE === "application/xhtml+xml" ? stringToString : stringToLowerCase;
    		ALLOWED_TAGS = _resolveSetOption(cfg, "ALLOWED_TAGS", DEFAULT_ALLOWED_TAGS, { transform: transformCaseFunc });
    		ALLOWED_ATTR = _resolveSetOption(cfg, "ALLOWED_ATTR", DEFAULT_ALLOWED_ATTR, { transform: transformCaseFunc });
    		ALLOWED_NAMESPACES = _resolveSetOption(cfg, "ALLOWED_NAMESPACES", DEFAULT_ALLOWED_NAMESPACES, { transform: stringToString });
    		URI_SAFE_ATTRIBUTES = _resolveSetOption(cfg, "ADD_URI_SAFE_ATTR", DEFAULT_URI_SAFE_ATTRIBUTES, {
    			transform: transformCaseFunc,
    			base: DEFAULT_URI_SAFE_ATTRIBUTES
    		});
    		DATA_URI_TAGS = _resolveSetOption(cfg, "ADD_DATA_URI_TAGS", DEFAULT_DATA_URI_TAGS, {
    			transform: transformCaseFunc,
    			base: DEFAULT_DATA_URI_TAGS
    		});
    		FORBID_CONTENTS = _resolveSetOption(cfg, "FORBID_CONTENTS", DEFAULT_FORBID_CONTENTS, { transform: transformCaseFunc });
    		FORBID_TAGS = _resolveSetOption(cfg, "FORBID_TAGS", clone({}), { transform: transformCaseFunc });
    		FORBID_ATTR = _resolveSetOption(cfg, "FORBID_ATTR", clone({}), { transform: transformCaseFunc });
    		USE_PROFILES = objectHasOwnProperty(cfg, "USE_PROFILES") ? cfg.USE_PROFILES && typeof cfg.USE_PROFILES === "object" ? clone(cfg.USE_PROFILES) : cfg.USE_PROFILES : false;
    		ALLOW_ARIA_ATTR = cfg.ALLOW_ARIA_ATTR !== false;
    		ALLOW_DATA_ATTR = cfg.ALLOW_DATA_ATTR !== false;
    		ALLOW_UNKNOWN_PROTOCOLS = cfg.ALLOW_UNKNOWN_PROTOCOLS || false;
    		ALLOW_SELF_CLOSE_IN_ATTR = cfg.ALLOW_SELF_CLOSE_IN_ATTR !== false;
    		SAFE_FOR_TEMPLATES = cfg.SAFE_FOR_TEMPLATES || false;
    		SAFE_FOR_XML = cfg.SAFE_FOR_XML !== false;
    		WHOLE_DOCUMENT = cfg.WHOLE_DOCUMENT || false;
    		RETURN_DOM = cfg.RETURN_DOM || false;
    		RETURN_DOM_FRAGMENT = cfg.RETURN_DOM_FRAGMENT || false;
    		RETURN_TRUSTED_TYPE = cfg.RETURN_TRUSTED_TYPE || false;
    		FORCE_BODY = cfg.FORCE_BODY || false;
    		SANITIZE_DOM = cfg.SANITIZE_DOM !== false;
    		SANITIZE_NAMED_PROPS = cfg.SANITIZE_NAMED_PROPS || false;
    		KEEP_CONTENT = cfg.KEEP_CONTENT !== false;
    		IN_PLACE = cfg.IN_PLACE || false;
    		IS_ALLOWED_URI$1 = isRegex(cfg.ALLOWED_URI_REGEXP) ? cfg.ALLOWED_URI_REGEXP : IS_ALLOWED_URI;
    		NAMESPACE = typeof cfg.NAMESPACE === "string" ? cfg.NAMESPACE : HTML_NAMESPACE;
    		MATHML_TEXT_INTEGRATION_POINTS = _resolveObjectOption(cfg, "MATHML_TEXT_INTEGRATION_POINTS", () => addToSet({}, DEFAULT_MATHML_TEXT_INTEGRATION_POINTS));
    		HTML_INTEGRATION_POINTS = _resolveObjectOption(cfg, "HTML_INTEGRATION_POINTS", () => addToSet({}, DEFAULT_HTML_INTEGRATION_POINTS));
    		const customElementHandling = _resolveObjectOption(cfg, "CUSTOM_ELEMENT_HANDLING", () => create(null));
    		CUSTOM_ELEMENT_HANDLING = create(null);
    		if (objectHasOwnProperty(customElementHandling, "tagNameCheck") && isRegexOrFunction(customElementHandling.tagNameCheck)) CUSTOM_ELEMENT_HANDLING.tagNameCheck = customElementHandling.tagNameCheck;
    		if (objectHasOwnProperty(customElementHandling, "attributeNameCheck") && isRegexOrFunction(customElementHandling.attributeNameCheck)) CUSTOM_ELEMENT_HANDLING.attributeNameCheck = customElementHandling.attributeNameCheck;
    		if (objectHasOwnProperty(customElementHandling, "allowCustomizedBuiltInElements") && typeof customElementHandling.allowCustomizedBuiltInElements === "boolean") CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements = customElementHandling.allowCustomizedBuiltInElements;
    		seal(CUSTOM_ELEMENT_HANDLING);
    		if (SAFE_FOR_TEMPLATES) ALLOW_DATA_ATTR = false;
    		if (RETURN_DOM_FRAGMENT) RETURN_DOM = true;
    		if (USE_PROFILES) {
    			ALLOWED_TAGS = addToSet({}, text);
    			ALLOWED_ATTR = create(null);
    			if (USE_PROFILES.html === true) {
    				addToSet(ALLOWED_TAGS, html$1);
    				addToSet(ALLOWED_ATTR, html);
    			}
    			if (USE_PROFILES.svg === true) {
    				addToSet(ALLOWED_TAGS, svg$1);
    				addToSet(ALLOWED_ATTR, svg);
    				addToSet(ALLOWED_ATTR, xml);
    			}
    			if (USE_PROFILES.svgFilters === true) {
    				addToSet(ALLOWED_TAGS, svgFilters);
    				addToSet(ALLOWED_ATTR, svg);
    				addToSet(ALLOWED_ATTR, xml);
    			}
    			if (USE_PROFILES.mathMl === true) {
    				addToSet(ALLOWED_TAGS, mathMl$1);
    				addToSet(ALLOWED_ATTR, mathMl);
    				addToSet(ALLOWED_ATTR, xml);
    			}
    		}
    		EXTRA_ELEMENT_HANDLING.tagCheck = null;
    		EXTRA_ELEMENT_HANDLING.attributeCheck = null;
    		if (objectHasOwnProperty(cfg, "ADD_TAGS")) {
    			if (typeof cfg.ADD_TAGS === "function") EXTRA_ELEMENT_HANDLING.tagCheck = cfg.ADD_TAGS;
    			else if (arrayIsArray(cfg.ADD_TAGS)) {
    				if (ALLOWED_TAGS === DEFAULT_ALLOWED_TAGS) ALLOWED_TAGS = clone(ALLOWED_TAGS);
    				addToSet(ALLOWED_TAGS, cfg.ADD_TAGS, transformCaseFunc);
    			}
    		}
    		if (objectHasOwnProperty(cfg, "ADD_ATTR")) {
    			if (typeof cfg.ADD_ATTR === "function") EXTRA_ELEMENT_HANDLING.attributeCheck = cfg.ADD_ATTR;
    			else if (arrayIsArray(cfg.ADD_ATTR)) {
    				if (ALLOWED_ATTR === DEFAULT_ALLOWED_ATTR) ALLOWED_ATTR = clone(ALLOWED_ATTR);
    				addToSet(ALLOWED_ATTR, cfg.ADD_ATTR, transformCaseFunc);
    			}
    		}
    		if (objectHasOwnProperty(cfg, "ADD_FORBID_CONTENTS") && arrayIsArray(cfg.ADD_FORBID_CONTENTS)) {
    			if (FORBID_CONTENTS === DEFAULT_FORBID_CONTENTS) FORBID_CONTENTS = clone(FORBID_CONTENTS);
    			addToSet(FORBID_CONTENTS, cfg.ADD_FORBID_CONTENTS, transformCaseFunc);
    		}
    		if (KEEP_CONTENT) ALLOWED_TAGS["#text"] = true;
    		if (WHOLE_DOCUMENT) addToSet(ALLOWED_TAGS, [
    			"html",
    			"head",
    			"body"
    		]);
    		if (ALLOWED_TAGS.table) {
    			addToSet(ALLOWED_TAGS, ["tbody"]);
    			delete FORBID_TAGS.tbody;
    		}
    		if (cfg.TRUSTED_TYPES_POLICY) {
    			if (typeof cfg.TRUSTED_TYPES_POLICY.createHTML !== "function") throw typeErrorCreate("TRUSTED_TYPES_POLICY configuration option must provide a \"createHTML\" hook.");
    			if (typeof cfg.TRUSTED_TYPES_POLICY.createScriptURL !== "function") throw typeErrorCreate("TRUSTED_TYPES_POLICY configuration option must provide a \"createScriptURL\" hook.");
    			const previousTrustedTypesPolicy = trustedTypesPolicy;
    			trustedTypesPolicy = cfg.TRUSTED_TYPES_POLICY;
    			try {
    				emptyHTML = _createTrustedHTML("");
    			} catch (error) {
    				trustedTypesPolicy = previousTrustedTypesPolicy;
    				throw error;
    			}
    		} else if (cfg.TRUSTED_TYPES_POLICY === null) {
    			trustedTypesPolicy = void 0;
    			emptyHTML = "";
    		} else {
    			if (trustedTypesPolicy === void 0) trustedTypesPolicy = _getDefaultTrustedTypesPolicy();
    			if (trustedTypesPolicy && typeof emptyHTML === "string") emptyHTML = _createTrustedHTML("");
    		}
    		if (freeze) freeze(cfg);
    		CONFIG = cfg;
    	};
    	const ALL_SVG_TAGS = addToSet({}, [
    		...svg$1,
    		...svgFilters,
    		...svgDisallowed
    	]);
    	const ALL_MATHML_TAGS = addToSet({}, [...mathMl$1, ...mathMlDisallowed]);
    	/**
    	* Namespace rules for an element in the SVG namespace.
    	*
    	* @param tagName the element's lowercase tag name
    	* @param parent the (possibly simulated) parent node
    	* @param parentTagName the parent's lowercase tag name
    	* @returns true if a spec-compliant parser could produce this element
    	*/
    	const _checkSvgNamespace = function _checkSvgNamespace(tagName, parent, parentTagName) {
    		if (parent.namespaceURI === HTML_NAMESPACE) return tagName === "svg";
    		if (parent.namespaceURI === MATHML_NAMESPACE) return tagName === "svg" && (parentTagName === "annotation-xml" || MATHML_TEXT_INTEGRATION_POINTS[parentTagName]);
    		return Boolean(ALL_SVG_TAGS[tagName]);
    	};
    	/**
    	* Namespace rules for an element in the MathML namespace.
    	*
    	* @param tagName the element's lowercase tag name
    	* @param parent the (possibly simulated) parent node
    	* @param parentTagName the parent's lowercase tag name
    	* @returns true if a spec-compliant parser could produce this element
    	*/
    	const _checkMathMlNamespace = function _checkMathMlNamespace(tagName, parent, parentTagName) {
    		if (parent.namespaceURI === HTML_NAMESPACE) return tagName === "math";
    		if (parent.namespaceURI === SVG_NAMESPACE) return tagName === "math" && HTML_INTEGRATION_POINTS[parentTagName];
    		return Boolean(ALL_MATHML_TAGS[tagName]);
    	};
    	/**
    	* Namespace rules for an element in the HTML namespace.
    	*
    	* @param tagName the element's lowercase tag name
    	* @param parent the (possibly simulated) parent node
    	* @param parentTagName the parent's lowercase tag name
    	* @returns true if a spec-compliant parser could produce this element
    	*/
    	const _checkHtmlNamespace = function _checkHtmlNamespace(tagName, parent, parentTagName) {
    		if (parent.namespaceURI === SVG_NAMESPACE && !HTML_INTEGRATION_POINTS[parentTagName]) return false;
    		if (parent.namespaceURI === MATHML_NAMESPACE && !MATHML_TEXT_INTEGRATION_POINTS[parentTagName]) return false;
    		return !ALL_MATHML_TAGS[tagName] && (COMMON_SVG_AND_HTML_ELEMENTS[tagName] || !ALL_SVG_TAGS[tagName]);
    	};
    	/**
    	* @param element a DOM element whose namespace is being checked
    	* @returns Return false if the element has a
    	*  namespace that a spec-compliant parser would never
    	*  return. Return true otherwise.
    	*/
    	const _checkValidNamespace = function _checkValidNamespace(element) {
    		let parent = getParentNode(element);
    		if (!parent || !parent.tagName) parent = {
    			namespaceURI: NAMESPACE,
    			tagName: "template"
    		};
    		const tagName = stringToLowerCase(element.tagName);
    		const parentTagName = stringToLowerCase(parent.tagName);
    		if (!ALLOWED_NAMESPACES[element.namespaceURI]) return false;
    		if (element.namespaceURI === SVG_NAMESPACE) return _checkSvgNamespace(tagName, parent, parentTagName);
    		if (element.namespaceURI === MATHML_NAMESPACE) return _checkMathMlNamespace(tagName, parent, parentTagName);
    		if (element.namespaceURI === HTML_NAMESPACE) return _checkHtmlNamespace(tagName, parent, parentTagName);
    		if (PARSER_MEDIA_TYPE === "application/xhtml+xml" && ALLOWED_NAMESPACES[element.namespaceURI]) return true;
    		return false;
    	};
    	/**
    	* _forceRemove
    	*
    	* @param node a DOM node
    	*/
    	const _forceRemove = function _forceRemove(node) {
    		arrayPush(DOMPurify.removed, { element: node });
    		try {
    			getParentNode(node).removeChild(node);
    		} catch (_) {
    			remove(node);
    			if (!getParentNode(node)) throw typeErrorCreate("a node selected for removal could not be detached from its tree and cannot be safely returned; refusing to sanitize in place");
    		}
    	};
    	/**
    	* _stripAttributeNode
    	*
    	* Remove a single Attr node case/namespace-exactly on an attribute-teardown
    	* path. Name-based removeAttribute() ASCII-lowercases its lookup key for an
    	* HTML element in an HTML document and so silently misses a case-preserved
    	* handler (e.g. `ONERROR` off an XML/XHTML import) - the same defect
    	* _removeAttribute() was fixed for, which a name-based call would reintroduce
    	* on these IN_PLACE teardown paths. Unlike _removeAttribute this does not
    	* record into DOMPurify.removed: the neutralize passes intentionally do not
    	* book-keep. A clobbered/detached node falls back to best-effort name-based
    	* removal.
    	*
    	* @param element the element to strip the attribute from
    	* @param attribute the Attr node to remove
    	* @param name the attribute's name, for the fallback path
    	*/
    	const _stripAttributeNode = function _stripAttributeNode(element, attribute, name) {
    		try {
    			removeAttributeNode(element, attribute);
    		} catch (_) {
    			try {
    				element.removeAttribute(name);
    			} catch (_) {}
    		}
    	};
    	/**
    	* _neutralizeRoot
    	*
    	* Fail-closed teardown of an in-place root after the sanitize walk aborts
    	* (campaign-3 F2). An internal throw mid-walk — e.g. a page-registered
    	* custom element's reaction detaches a node so `_forceRemove`'s deliberate
    	* parentless guard throws, or any other re-entrant engine mutation — would
    	* otherwise leave the caller's *live* tree half-sanitized, with everything
    	* after the abort point still carrying its handlers. There is no safe way
    	* to resume the walk (the tree mutated under us), so we strip the root bare:
    	* remove every child and every attribute, then let the caller's catch see
    	* the original error. Clobber-safe (cached `remove`/`childNodes`/`attributes`
    	* getters; the root was already clobber-pre-flighted at the IN_PLACE entry).
    	*
    	* @param root the in-place root to empty
    	*/
    	const _neutralizeRoot = function _neutralizeRoot(root) {
    		_neutralizeSubtree(root);
    		const childNodes = getChildNodes(root);
    		if (childNodes) {
    			const snapshot = [];
    			arrayForEach(childNodes, (child) => {
    				arrayPush(snapshot, child);
    			});
    			arrayForEach(snapshot, (child) => {
    				try {
    					remove(child);
    				} catch (_) {}
    			});
    		}
    		const attributes = getAttributes(root);
    		if (attributes) for (let i = attributes.length - 1; i >= 0; --i) {
    			const attribute = attributes[i];
    			const name = attribute && attribute.name;
    			if (typeof name === "string") _stripAttributeNode(root, attribute, name);
    		}
    	};
    	/**
    	* _removeAttribute
    	*
    	* Name-based getAttributeNode()/removeAttribute() ASCII-lowercase their
    	* lookup key for HTML elements in an HTML document, so they silently miss an
    	* attribute whose stored qualified name still contains uppercase ASCII
    	* letters. That happens when the node came from a case-preserving source
    	* (an XML/XHTML document imported via importNode(), or createAttributeNS()),
    	* where e.g. `ONERROR` survives the walk: the policy check lowercases to
    	* `onerror` and rejects it, but `removeAttribute('ONERROR')` looks up
    	* `onerror` and finds nothing. Remove the exact Attr node instead, which is
    	* case- and namespace-exact, and fall back to name-based removal only when
    	* the caller could not supply the node.
    	*
    	* @param name an Attribute name
    	* @param element a DOM node
    	* @param attr the exact Attr node to remove, when the caller has it
    	*/
    	const _removeAttribute = function _removeAttribute(name, element, attr) {
    		if (!attr) try {
    			attr = element.getAttributeNode(name);
    		} catch (_) {
    			attr = null;
    		}
    		arrayPush(DOMPurify.removed, {
    			attribute: attr || null,
    			from: element
    		});
    		try {
    			if (attr) removeAttributeNode(element, attr);
    			else element.removeAttribute(name);
    		} catch (_) {
    			try {
    				element.removeAttribute(name);
    			} catch (_) {}
    		}
    		if (name === "is") {
    			if (RETURN_DOM || RETURN_DOM_FRAGMENT) try {
    				_forceRemove(element);
    			} catch (_) {}
    			else try {
    				element.setAttribute(name, "");
    			} catch (_) {}
    		}
    	};
    	/**
    	* _stripDisallowedAttributes
    	*
    	* Removes every attribute the active configuration does not allow from a
    	* single element, using the same allowlist as the main attribute pass (so
    	* `on*` handlers go, but no `/^on/` blocklist is introduced). Used only to
    	* neutralise nodes that are being discarded from an in-place tree.
    	*
    	* @param element the element to strip
    	*/
    	const _stripDisallowedAttributes = function _stripDisallowedAttributes(element) {
    		const attributes = getAttributes(element);
    		if (!attributes) return;
    		for (let i = attributes.length - 1; i >= 0; --i) {
    			const attribute = attributes[i];
    			const name = attribute && attribute.name;
    			if (typeof name !== "string" || ALLOWED_ATTR[transformCaseFunc(name)]) continue;
    			_stripAttributeNode(element, attribute, name);
    		}
    	};
    	/**
    	* _neutralizeSubtree
    	*
    	* Completes the audit-5 F1 fix across every removal path. The KEEP_CONTENT
    	* move-hoist neutralises only disallowed-tag removals; clobber, mXSS-canary,
    	* namespace, comment, processing-instruction and KEEP_CONTENT:false removals
    	* all drop their subtree wholesale via `_forceRemove`. On the IN_PLACE path
    	* those dropped nodes are detached from the caller's LIVE tree but a
    	* handler-bearing original among them (an `<img onerror>`/`<video>` that was
    	* loading) keeps its queued resource event, which fires in page scope after
    	* sanitize returns. This walks a removed subtree and strips every attribute
    	* the active configuration does not allow — so `on*` handlers are cancelled
    	* through the SAME allowlist that governs kept nodes, not a separate `/^on/`
    	* blocklist. Run synchronously before sanitize returns, i.e. before any
    	* queued event can fire. Hook-free by design: these nodes leave the output,
    	* so firing attribute hooks for them would be surprising. Clobber-safe reads;
    	* a doomed clobbered node may shadow `removeAttribute` (its own attributes are
    	* irrelevant — it is discarded — while its non-clobbered descendants, e.g.
    	* the `<img>`, are reached and scrubbed).
    	*
    	* @param root the root of a removed subtree to neutralise
    	*/
    	const _neutralizeSubtree = function _neutralizeSubtree(root) {
    		const stack = [root];
    		while (stack.length > 0) {
    			const node = stack.pop();
    			if (_readNodeType(node) === NODE_TYPE.element) _stripDisallowedAttributes(node);
    			const childNodes = getChildNodes(node);
    			if (childNodes) for (let i = childNodes.length - 1; i >= 0; --i) stack.push(childNodes[i]);
    		}
    	};
    	/**
    	* _neutralizePatchLinkage
    	*
    	* IN_PLACE entry pre-pass (declarative-partial-updates / streaming
    	* hardening, https://github.com/WICG/declarative-partial-updates).
    	*
    	* The main walk strips patch linkage (`for`/`patchsrc`) and removes range
    	* markers (PIs / markup comments) node-by-node, in document order, AS it
    	* reaches each node. On a live in-place root that leaves a window: from the
    	* moment the root is connected until the walk arrives at a given node, that
    	* node's linkage is live. A patch applied on connection/stream can fire as
    	* a microtask during the walk and inject or teleport an unsanitized DOM
    	* range into a region the iterator has already passed and will not revisit,
    	* so the post-return "tree is sanitized" contract is violated. Sweep the
    	* whole tree once up front and sever every linkage before the walk begins,
    	* closing that window.
    	*
    	* This CANNOT undo a patch that already fired before sanitize ran — that is
    	* the irreducible "do not IN_PLACE a live-connected attacker tree" caveat —
    	* but it closes everything from sanitize-start onward. Gated on SAFE_FOR_XML
    	* to group with the rest of the declarative-partial-updates handling and
    	* stay overridable, consistent with the codebase.
    	*
    	* Clobber-safe traversal (cached childNodes getter); per-node try/catch so a
    	* clobbered root cannot defeat the sweep of its non-clobbered descendants.
    	*
    	* NOTE (pending real-Chrome confirmation, see test/declarative-patch-probe
    	* .html Q1): this mirrors the existing policy of keeping `for` on
    	* <label>/<output>. If the shipping feature can drive a patch through a
    	* surviving `for`-on-label/output + `id` pair, this pre-pass and the
    	* attribute check at _isBasicCustomElement's caller must additionally drop
    	* that pair on the IN_PLACE path. Left as-is until the taxonomy is verified.
    	*
    	* @param root the in-place root to sweep
    	*/
    	/**
    	* Central policy for declarative-partial-updates patch-linkage attributes,
    	* shared by the _neutralizePatchLinkage pre-pass and _isValidAttribute so
    	* the two sites cannot drift: `patchsrc` always links, `for` links
    	* everywhere except on <label>/<output>, and the whole policy is gated on
    	* SAFE_FOR_XML (see the rationale block in _isValidAttribute).
    	*
    	* @param lcName the transformCaseFunc'd attribute name
    	* @param lcTag the transformCaseFunc'd tag name of the carrying element
    	* @return true if the attribute is patch linkage and must be dropped
    	*/
    	const _isPatchLinkageAttribute = function _isPatchLinkageAttribute(lcName, lcTag) {
    		if (!SAFE_FOR_XML) return false;
    		if (lcName === "patchsrc") return true;
    		return lcName === "for" && lcTag !== "label" && lcTag !== "output";
    	};
    	const _neutralizePatchLinkage = function _neutralizePatchLinkage(root) {
    		if (!SAFE_FOR_XML) return;
    		const stack = [root];
    		while (stack.length > 0) {
    			const node = stack.pop();
    			const nodeType = _readNodeType(node);
    			if (nodeType === NODE_TYPE.processingInstruction || nodeType === NODE_TYPE.comment && regExpTest(COMMENT_MARKUP_PROBE, node.data)) {
    				try {
    					remove(node);
    				} catch (_) {}
    				continue;
    			}
    			if (nodeType === NODE_TYPE.element) {
    				const element = node;
    				const lcTag = transformCaseFunc(_readNodeName(node));
    				try {
    					if (element.hasAttribute && element.hasAttribute("patchsrc")) element.removeAttribute("patchsrc");
    					if (element.hasAttribute && element.hasAttribute("for") && _isPatchLinkageAttribute("for", lcTag)) element.removeAttribute("for");
    				} catch (_) {}
    			}
    			const childNodes = getChildNodes(node);
    			if (childNodes) for (let i = childNodes.length - 1; i >= 0; --i) stack.push(childNodes[i]);
    		}
    	};
    	/**
    	* _initDocument
    	*
    	* @param dirty - a string of dirty markup
    	* @return a DOM, filled with the dirty markup
    	*/
    	const _initDocument = function _initDocument(dirty) {
    		let doc = null;
    		let leadingWhitespace = null;
    		if (FORCE_BODY) dirty = "<remove></remove>" + dirty;
    		else {
    			const matches = stringMatch(dirty, /^[\r\n\t ]+/);
    			leadingWhitespace = matches && matches[0];
    		}
    		if (PARSER_MEDIA_TYPE === "application/xhtml+xml" && NAMESPACE === HTML_NAMESPACE) dirty = "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head></head><body>" + dirty + "</body></html>";
    		const dirtyPayload = trustedTypesPolicy ? _createTrustedHTML(dirty) : dirty;
    		if (NAMESPACE === HTML_NAMESPACE) try {
    			doc = new DOMParser().parseFromString(dirtyPayload, PARSER_MEDIA_TYPE);
    		} catch (_) {}
    		if (!doc || !doc.documentElement) {
    			doc = implementation.createDocument(NAMESPACE, "template", null);
    			try {
    				doc.documentElement.innerHTML = IS_EMPTY_INPUT ? emptyHTML : dirtyPayload;
    			} catch (_) {}
    		}
    		const body = doc.body || doc.documentElement;
    		if (dirty && leadingWhitespace) body.insertBefore(document.createTextNode(leadingWhitespace), body.childNodes[0] || null);
    		if (NAMESPACE === HTML_NAMESPACE) return getElementsByTagName.call(doc, WHOLE_DOCUMENT ? "html" : "body")[0];
    		return WHOLE_DOCUMENT ? doc.documentElement : body;
    	};
    	/**
    	* Creates a NodeIterator object that you can use to traverse filtered lists of nodes or elements in a document.
    	*
    	* @param root The root element or node to start traversing on.
    	* @return The created NodeIterator
    	*/
    	const _createNodeIterator = function _createNodeIterator(root) {
    		const doc = getOwnerDocument ? getOwnerDocument(root) : root.ownerDocument;
    		return createNodeIterator.call(doc || root, root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_PROCESSING_INSTRUCTION | NodeFilter.SHOW_CDATA_SECTION, null);
    	};
    	/**
    	* Replace template expression syntax (mustache, ERB, template
    	* literal) with a space; shared by all SAFE_FOR_TEMPLATES scrub
    	* sites. Order matters: mustache, then ERB, then template literal.
    	*
    	* @param value the string to scrub
    	* @returns the scrubbed string
    	*/
    	const _stripTemplateExpressions = function _stripTemplateExpressions(value) {
    		value = stringReplace(value, MUSTACHE_EXPR$1, " ");
    		value = stringReplace(value, ERB_EXPR$1, " ");
    		value = stringReplace(value, TMPLIT_EXPR$1, " ");
    		return value;
    	};
    	/**
    	* Strip template-engine expressions ({{...}}, ${...}, <%...%>) from the
    	* character data of an element subtree. Used as the final safety net for
    	* SAFE_FOR_TEMPLATES on every DOM-returning code path so that expressions
    	* which only form after text-node normalization (e.g. fragments split across
    	* stripped elements) cannot survive into a template-evaluating framework.
    	*
    	* Walks text/comment/CDATA/processing-instruction nodes and mutates `.data`
    	* in place rather than round-tripping through innerHTML. This preserves
    	* descendant node references (important for IN_PLACE callers), avoids a
    	* serialize/reparse cycle, and reads literal character data — which means
    	* `<%...%>` in text content matches the ERB regex against its real bytes
    	* instead of the HTML-entity-escaped form innerHTML would produce.
    	*
    	* Attribute values are not visited here; SAFE_FOR_TEMPLATES handling for
    	* attributes is performed during the per-node `_sanitizeAttributes` pass.
    	*
    	* @param node The root element whose character data should be scrubbed.
    	*/
    	const _scrubTemplateExpressions2 = function _scrubTemplateExpressions(node) {
    		var _node$querySelectorAl;
    		node.normalize();
    		const doc = getOwnerDocument ? getOwnerDocument(node) : node.ownerDocument;
    		const walker = createNodeIterator.call(doc || node, node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_CDATA_SECTION | NodeFilter.SHOW_PROCESSING_INSTRUCTION, null);
    		let currentNode = walker.nextNode();
    		while (currentNode) {
    			currentNode.data = _stripTemplateExpressions(currentNode.data);
    			currentNode = walker.nextNode();
    		}
    		const templates = (_node$querySelectorAl = node.querySelectorAll) === null || _node$querySelectorAl === void 0 ? void 0 : _node$querySelectorAl.call(node, "template");
    		if (templates) arrayForEach(templates, (tmpl) => {
    			if (_isDocumentFragment(tmpl.content)) _scrubTemplateExpressions2(tmpl.content);
    		});
    	};
    	/**
    	* _isClobbered
    	*
    	* Detect DOM-clobbering on HTMLFormElement nodes. Form is the only HTML
    	* interface with [LegacyOverrideBuiltIns]; a descendant element with a
    	* `name` attribute matching a prototype property shadows that property
    	* on direct reads. We use this check at the IN_PLACE entry-point and
    	* during attribute sanitization to refuse clobbered forms.
    	*
    	* @param element element to check for clobbering attacks
    	* @return true if clobbered, false if safe
    	*/
    	const _isClobbered = function _isClobbered(element) {
    		const realTagName = getNodeName ? getNodeName(element) : null;
    		if (typeof realTagName !== "string") return false;
    		if (transformCaseFunc(realTagName) !== "form") return false;
    		return typeof element.nodeName !== "string" || typeof element.textContent !== "string" || typeof element.removeChild !== "function" || element.attributes !== getAttributes(element) || typeof element.removeAttribute !== "function" || typeof element.removeAttributeNode !== "function" || typeof element.getAttributeNode !== "function" || typeof element.setAttribute !== "function" || typeof element.namespaceURI !== "string" || typeof element.insertBefore !== "function" || typeof element.hasChildNodes !== "function" || element.nodeType !== getNodeType(element) || element.childNodes !== getChildNodes(element);
    	};
    	/**
    	* Checks whether the given value is a DocumentFragment from any realm.
    	*
    	* The realm-independent replacement reads `nodeType` through the cached
    	* Node.prototype getter and compares to the DOCUMENT_FRAGMENT_NODE
    	* constant (11). nodeType is a numeric value resolved from the node's
    	* internal slot, identical across realms for the same kind of node.
    	*
    	* @param value object to check
    	* @return true if value is a DocumentFragment-shaped node from any realm
    	*/
    	const _isDocumentFragment = function _isDocumentFragment(value) {
    		if (!getNodeType || typeof value !== "object" || value === null) return false;
    		try {
    			return getNodeType(value) === NODE_TYPE.documentFragment;
    		} catch (_) {
    			return false;
    		}
    	};
    	/**
    	* Checks whether the given object is a DOM node, including nodes that
    	* originate from a different window/realm (e.g. an iframe's
    	* contentDocument). The previous `value instanceof Node` check was
    	* realm-bound: nodes from a different window failed it, causing
    	* sanitize() to silently stringify them and reset IN_PLACE to false,
    	* returning the original node unsanitized. See GHSA-4w3q-35jp-p934.
    	*
    	* @param value object to check whether it's a DOM node
    	* @return true if value is a DOM node from any realm
    	*/
    	const _isNode = function _isNode(value) {
    		if (!getNodeType || typeof value !== "object" || value === null) return false;
    		try {
    			return typeof getNodeType(value) === "number";
    		} catch (_) {
    			return false;
    		}
    	};
    	function _executeHooks(hooks, currentNode, data) {
    		if (hooks.length === 0) return;
    		arrayForEach(hooks, (hook) => {
    			hook.call(DOMPurify, currentNode, data, CONFIG);
    		});
    	}
    	/**
    	* Structural-threat checks that condemn a node regardless of the
    	* allowlists: mXSS via namespace confusion, risky CSS construction,
    	* processing instructions, markup-bearing comments. Pure predicate;
    	* the caller removes. Check order is load-bearing.
    	*
    	* @param currentNode the node to inspect
    	* @param tagName the node's transformCaseFunc'd tag name
    	* @return true if the node must be removed
    	*/
    	const _isUnsafeNode = function _isUnsafeNode(currentNode, tagName) {
    		if (SAFE_FOR_XML && currentNode.hasChildNodes() && !_isNode(currentNode.firstElementChild) && regExpTest(ELEMENT_MARKUP_PROBE, currentNode.textContent) && regExpTest(ELEMENT_MARKUP_PROBE, currentNode.innerHTML)) return true;
    		if (SAFE_FOR_XML && currentNode.namespaceURI === HTML_NAMESPACE && LITERAL_TEXT_ELEMENTS[tagName] && (_isNode(currentNode.firstElementChild) || typeof currentNode.textContent === "string" && regExpTest(LITERAL_TEXT_CLOSE[tagName], currentNode.textContent))) return true;
    		if (currentNode.nodeType === NODE_TYPE.processingInstruction) return true;
    		if (SAFE_FOR_XML && currentNode.nodeType === NODE_TYPE.comment && regExpTest(COMMENT_MARKUP_PROBE, currentNode.data)) return true;
    		return false;
    	};
    	/**
    	* Evaluate a CUSTOM_ELEMENT_HANDLING check (a RegExp or a predicate
    	* function, per the validation in _parseConfig) against a name.
    	* Additional arguments are forwarded to predicate functions - the
    	* attributeNameCheck predicate receives the tag name as its second
    	* argument. A null/absent check never matches.
    	*
    	* @param check the configured tagNameCheck / attributeNameCheck value
    	* @param name the name to test
    	* @param args extra arguments forwarded to a predicate function
    	* @return true if the check matches the name
    	*/
    	const _matchesNameCheck = function _matchesNameCheck(check, name) {
    		if (check instanceof RegExp) return regExpTest(check, name);
    		if (check instanceof Function) {
    			for (var _len = arguments.length, args = new Array(_len > 2 ? _len - 2 : 0), _key = 2; _key < _len; _key++) args[_key - 2] = arguments[_key];
    			return Boolean(check(name, ...args));
    		}
    		return false;
    	};
    	/**
    	* Handle a node whose tag is forbidden or not allowlisted: keep
    	* allowed custom elements (false return exits _sanitizeElements
    	* early - the namespace and fallback-tag removal checks are
    	* intentionally skipped for kept custom elements), else hoist
    	* content per KEEP_CONTENT and remove.
    	*
    	* A kept custom element is the ONLY case in which this function
    	* returns false, so the caller uses that return value to run the
    	* afterSanitizeElements hook on the kept element and keep the
    	* element-hook lifecycle consistent with normal allowlisted
    	* elements (GHSA-c2j3-45gr-mqc4).
    	*
    	* @param currentNode the disallowed node
    	* @param tagName the node's transformCaseFunc'd tag name
    	* @return true if the node was removed, false if kept
    	*/
    	const _sanitizeDisallowedNode = function _sanitizeDisallowedNode(currentNode, tagName, root) {
    		if (!FORBID_TAGS[tagName] && _isBasicCustomElement(tagName) && _matchesNameCheck(CUSTOM_ELEMENT_HANDLING.tagNameCheck, tagName)) return false;
    		if (KEEP_CONTENT && !FORBID_CONTENTS[tagName]) {
    			const parentNode = getParentNode(currentNode);
    			const childNodes = getChildNodes(currentNode);
    			if (childNodes && parentNode) {
    				const childCount = childNodes.length;
    				for (let i = childCount - 1; i >= 0; --i) {
    					const hoisted = currentNode === root ? cloneNode(childNodes[i], true) : childNodes[i];
    					parentNode.insertBefore(hoisted, getNextSibling(currentNode));
    				}
    			}
    		}
    		_forceRemove(currentNode);
    		return true;
    	};
    	/**
    	* Fork a hook-mutable allowlist off its shared binding the first time a
    	* (possibly lazily-installed) uponSanitize* hook is about to see it, so the
    	* hook cannot widen the per-instance default or the setConfig binding by
    	* reference and leak past the call. Returns the set unchanged once it is
    	* already call-local, so repeated calls across elements are idempotent.
    	*
    	* @param hookList the uponSanitize* hook array for this event
    	* @param set the current ALLOWED_TAGS / ALLOWED_ATTR binding
    	* @param defaultSet the per-instance DEFAULT_ALLOWED_* constant
    	* @param setConfigSet the captured setConfig() binding, or null
    	* @return a call-local clone if a hook is present and set is still shared,
    	*   else set unchanged
    	*/
    	const _forkSharedAllowlist = function _forkSharedAllowlist(hookList, set, defaultSet, setConfigSet) {
    		if (hookList.length === 0) return set;
    		return set === defaultSet || set === setConfigSet ? clone(set) : set;
    	};
    	/**
    	* Shared guard for a node that a hook has detached from the walk tree,
    	* used after each element-hook site in _sanitizeElements. Detaching is a
    	* long-standing user pattern (issue #469; draw.io-style foreignObject
    	* filtering). Per the cached, unclobberable parentNode getter the node is
    	* genuinely out of the tree, so it can reach neither the serialized
    	* output nor an IN_PLACE live tree; treat it as removed and stop
    	* processing it. Without this guard, the unsafe-node / namespace checks
    	* would call _forceRemove on a parentless node and hit the REPORT-3
    	* fail-closed throw — which exists for nodes DOMPurify wants gone but
    	* *cannot* detach (clobbered / parentless roots), the opposite of a node
    	* that is already safely gone. The walk root is exempt: a detached
    	* IN_PLACE root is legitimate input and must still be fully sanitized,
    	* and a kill-decision on it must keep hitting the REPORT-3 throw.
    	*
    	* Nodes detached by hooks stay the hook's responsibility for placement:
    	* they are not recorded in DOMPurify.removed, so the post-walk IN_PLACE
    	* pass (which iterates DOMPurify.removed) does not reach them. But a
    	* hook-detached subtree can still hold a queued resource-event handler -
    	* e.g. an <img onload> that began loading when the caller built the live
    	* tree - which fires in page scope after sanitize returns even though the
    	* handler never reached the returned tree. That is the audit-5 F1 hazard,
    	* and the documented node.remove() hook pattern walks straight into it.
    	* So on the IN_PLACE path we neutralize the detached subtree inline,
    	* stripping its non-allow-listed attributes before returning, exactly as
    	* the post-walk pass does for _forceRemove'd subtrees.
    	*
    	* @param currentNode the node a hook may have detached
    	* @param root the current walk root
    	* @return true if the node is detached and now handled, false otherwise
    	*/
    	const _handleHookDetachedNode = function _handleHookDetachedNode(currentNode, root) {
    		if (currentNode === root || getParentNode(currentNode) !== null) return false;
    		if (IN_PLACE) _neutralizeSubtree(currentNode);
    		return true;
    	};
    	/**
    	* _sanitizeElements
    	*
    	* @protect nodeName
    	* @protect textContent
    	* @protect removeChild
    	* @param currentNode to check for permission to exist
    	* @return true if node was killed, false if left alive
    	*/
    	const _sanitizeElements = function _sanitizeElements(currentNode, root) {
    		_executeHooks(hooks.beforeSanitizeElements, currentNode, null);
    		if (_handleHookDetachedNode(currentNode, root)) return true;
    		if (_isClobbered(currentNode)) {
    			_forceRemove(currentNode);
    			return true;
    		}
    		const tagName = transformCaseFunc(_readNodeName(currentNode));
    		ALLOWED_TAGS = _forkSharedAllowlist(hooks.uponSanitizeElement, ALLOWED_TAGS, DEFAULT_ALLOWED_TAGS, SET_CONFIG_ALLOWED_TAGS);
    		_executeHooks(hooks.uponSanitizeElement, currentNode, {
    			tagName,
    			allowedTags: ALLOWED_TAGS
    		});
    		if (_handleHookDetachedNode(currentNode, root)) return true;
    		if (_isUnsafeNode(currentNode, tagName)) {
    			_forceRemove(currentNode);
    			return true;
    		}
    		if (FORBID_TAGS[tagName] || !(EXTRA_ELEMENT_HANDLING.tagCheck instanceof Function && EXTRA_ELEMENT_HANDLING.tagCheck(tagName)) && !ALLOWED_TAGS[tagName]) {
    			const removed = _sanitizeDisallowedNode(currentNode, tagName, root);
    			if (removed === false) {
    				_executeHooks(hooks.afterSanitizeElements, currentNode, null);
    				if (_handleHookDetachedNode(currentNode, root)) return true;
    			}
    			return removed;
    		}
    		if (_readNodeType(currentNode) === NODE_TYPE.element && !_checkValidNamespace(currentNode)) {
    			_forceRemove(currentNode);
    			return true;
    		}
    		if ((tagName === "noscript" || tagName === "noembed" || tagName === "noframes") && regExpTest(FALLBACK_TAG_CLOSE, currentNode.innerHTML)) {
    			_forceRemove(currentNode);
    			return true;
    		}
    		if (SAFE_FOR_TEMPLATES && currentNode.nodeType === NODE_TYPE.text) {
    			const content = _stripTemplateExpressions(currentNode.textContent);
    			if (currentNode.textContent !== content) {
    				arrayPush(DOMPurify.removed, { element: currentNode.cloneNode() });
    				currentNode.textContent = content;
    			}
    		}
    		_executeHooks(hooks.afterSanitizeElements, currentNode, null);
    		return _handleHookDetachedNode(currentNode, root);
    	};
    	/**
    	* _isValidAttribute
    	*
    	* @param lcTag Lowercase tag name of containing element.
    	* @param lcName Lowercase attribute name.
    	* @param value Attribute value.
    	* @return Returns true if `value` is valid, otherwise false.
    	*/
    	const _isValidAttribute = function _isValidAttribute(lcTag, lcName, value) {
    		if (FORBID_ATTR[lcName]) return false;
    		if (_isPatchLinkageAttribute(lcName, lcTag)) return false;
    		if (SANITIZE_DOM && (lcName === "id" || lcName === "name") && (value in document || value in formElement)) return false;
    		const nameIsPermitted = ALLOWED_ATTR[lcName] || EXTRA_ELEMENT_HANDLING.attributeCheck instanceof Function && EXTRA_ELEMENT_HANDLING.attributeCheck(lcName, lcTag);
    		if (ALLOW_DATA_ATTR && regExpTest(DATA_ATTR$1, lcName)) return true;
    		if (ALLOW_ARIA_ATTR && regExpTest(ARIA_ATTR$1, lcName)) return true;
    		if (!nameIsPermitted) return _isBasicCustomElement(lcTag) && _matchesNameCheck(CUSTOM_ELEMENT_HANDLING.tagNameCheck, lcTag) && _matchesNameCheck(CUSTOM_ELEMENT_HANDLING.attributeNameCheck, lcName, lcTag) || lcName === "is" && CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements && _matchesNameCheck(CUSTOM_ELEMENT_HANDLING.tagNameCheck, value);
    		if (URI_SAFE_ATTRIBUTES[lcName]) return true;
    		if (regExpTest(IS_ALLOWED_URI$1, stringReplace(value, ATTR_WHITESPACE$1, ""))) return true;
    		if ((lcName === "src" || lcName === "xlink:href" || lcName === "href") && lcTag !== "script" && stringIndexOf(value, "data:") === 0 && DATA_URI_TAGS[lcTag]) return true;
    		if (ALLOW_UNKNOWN_PROTOCOLS && !regExpTest(IS_SCRIPT_OR_DATA$1, stringReplace(value, ATTR_WHITESPACE$1, ""))) return true;
    		return !value;
    	};
    	const RESERVED_CUSTOM_ELEMENT_NAMES = addToSet({}, [
    		"annotation-xml",
    		"color-profile",
    		"font-face",
    		"font-face-format",
    		"font-face-name",
    		"font-face-src",
    		"font-face-uri",
    		"missing-glyph"
    	]);
    	/**
    	* _isBasicCustomElement
    	* checks if at least one dash is included in tagName, and it's not the first char
    	* for more sophisticated checking see https://github.com/sindresorhus/validate-element-name
    	*
    	* @param tagName name of the tag of the node to sanitize
    	* @returns Returns true if the tag name meets the basic criteria for a custom element, otherwise false.
    	*/
    	const _isBasicCustomElement = function _isBasicCustomElement(tagName) {
    		return !RESERVED_CUSTOM_ELEMENT_NAMES[stringToLowerCase(tagName)] && regExpTest(CUSTOM_ELEMENT$1, tagName);
    	};
    	/**
    	* Wrap an attribute value in the matching Trusted Types object when
    	* the active policy requires it. Namespaced attributes pass through
    	* unchanged (no TT support yet, see
    	* https://bugs.chromium.org/p/chromium/issues/detail?id=1305293).
    	*
    	* @param lcTag lowercase tag name of the containing element
    	* @param lcName lowercase attribute name
    	* @param namespaceURI the attribute's namespace, if any
    	* @param value the attribute value to wrap
    	* @return the value, wrapped when Trusted Types demand it
    	*/
    	const _applyTrustedTypesToAttribute = function _applyTrustedTypesToAttribute(lcTag, lcName, namespaceURI, value) {
    		if (trustedTypesPolicy && typeof trustedTypes === "object" && typeof trustedTypes.getAttributeType === "function" && !namespaceURI) switch (trustedTypes.getAttributeType(lcTag, lcName)) {
    			case "TrustedHTML": return _createTrustedHTML(value);
    			case "TrustedScriptURL": return _createTrustedScriptURL(value);
    		}
    		return value;
    	};
    	/**
    	* Write a modified attribute value back onto the element. On
    	* success, re-probe for clobbering introduced by the new value and
    	* remove the element when found; otherwise, when this writeback is the
    	* recreate half of the SANITIZE_NAMED_PROPS remove-and-recreate, pop the
    	* removal entry that path recorded so it does not show as removed. On
    	* failure, remove the attribute instead.
    	*
    	* Returns true only on a clean write (the value was set and the new value
    	* introduced no clobbering). The caller uses that, together with its own
    	* knowledge of whether this attribute pushed a DOMPurify.removed record, to
    	* decide whether to pop that record. The pop must happen ONLY for the
    	* named-prop remove-and-recreate; popping on any other value change (trim,
    	* template scrubbing, Trusted Types) would consume an unrelated _forceRemove
    	* subtree-cleanup record and let that detached subtree keep a live event
    	* handler through the IN_PLACE neutralization pass (SO-001).
    	*
    	* @param currentNode the element carrying the attribute
    	* @param name the attribute name as present on the element
    	* @param namespaceURI the attribute's namespace, if any
    	* @param value the new attribute value
    	* @return true if the value was written without introducing clobbering
    	*/
    	const _setAttributeValue = function _setAttributeValue(currentNode, name, namespaceURI, value) {
    		try {
    			if (namespaceURI) currentNode.setAttributeNS(namespaceURI, name, value);
    			else currentNode.setAttribute(name, value);
    			if (_isClobbered(currentNode)) {
    				_forceRemove(currentNode);
    				return false;
    			}
    			return true;
    		} catch (_) {
    			_removeAttribute(name, currentNode);
    			return false;
    		}
    	};
    	/**
    	* _sanitizeAttributes
    	*
    	* @protect attributes
    	* @protect nodeName
    	* @protect removeAttribute
    	* @protect setAttribute
    	*
    	* @param currentNode to sanitize
    	* @param root the current walk root
    	*/
    	const _sanitizeAttributes = function _sanitizeAttributes(currentNode, root) {
    		_executeHooks(hooks.beforeSanitizeAttributes, currentNode, null);
    		if (_handleHookDetachedNode(currentNode, root)) return;
    		const attributes = currentNode.attributes;
    		if (!attributes || _isClobbered(currentNode)) return;
    		ALLOWED_ATTR = _forkSharedAllowlist(hooks.uponSanitizeAttribute, ALLOWED_ATTR, DEFAULT_ALLOWED_ATTR, SET_CONFIG_ALLOWED_ATTR);
    		const hookEvent = {
    			attrName: "",
    			attrValue: "",
    			keepAttr: true,
    			allowedAttributes: ALLOWED_ATTR,
    			forceKeepAttr: void 0
    		};
    		let l = attributes.length;
    		const lcTag = transformCaseFunc(currentNode.nodeName);
    		while (l--) {
    			const attr = attributes[l];
    			const name = attr.name, namespaceURI = attr.namespaceURI, attrValue = attr.value;
    			const lcName = transformCaseFunc(name);
    			const initValue = attrValue;
    			let value = name === "value" ? initValue : stringTrim(initValue);
    			let recreatedNamedProp = false;
    			hookEvent.attrName = lcName;
    			hookEvent.attrValue = value;
    			hookEvent.keepAttr = true;
    			hookEvent.forceKeepAttr = void 0;
    			_executeHooks(hooks.uponSanitizeAttribute, currentNode, hookEvent);
    			value = hookEvent.attrValue;
    			if (SANITIZE_NAMED_PROPS && (lcName === "id" || lcName === "name") && stringIndexOf(value, SANITIZE_NAMED_PROPS_PREFIX) !== 0) {
    				_removeAttribute(name, currentNode, attr);
    				value = SANITIZE_NAMED_PROPS_PREFIX + value;
    				recreatedNamedProp = true;
    			}
    			if (SAFE_FOR_XML && regExpTest(/((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i, value)) {
    				_removeAttribute(name, currentNode, attr);
    				continue;
    			}
    			if (lcName === "attributename" && stringMatch(value, "href")) {
    				_removeAttribute(name, currentNode, attr);
    				continue;
    			}
    			if (hookEvent.forceKeepAttr) continue;
    			if (!hookEvent.keepAttr) {
    				_removeAttribute(name, currentNode, attr);
    				continue;
    			}
    			if (!ALLOW_SELF_CLOSE_IN_ATTR && regExpTest(SELF_CLOSING_TAG, value)) {
    				_removeAttribute(name, currentNode, attr);
    				continue;
    			}
    			if (SAFE_FOR_TEMPLATES) value = _stripTemplateExpressions(value);
    			if (!_isValidAttribute(lcTag, lcName, value)) {
    				_removeAttribute(name, currentNode, attr);
    				continue;
    			}
    			value = _applyTrustedTypesToAttribute(lcTag, lcName, namespaceURI, value);
    			if (value !== initValue) {
    				if (_setAttributeValue(currentNode, name, namespaceURI, value) && recreatedNamedProp) arrayPop(DOMPurify.removed);
    			}
    		}
    		_executeHooks(hooks.afterSanitizeAttributes, currentNode, null);
    		_handleHookDetachedNode(currentNode, root);
    	};
    	/**
    	* _sanitizeShadowDOM
    	*
    	* @param fragment to iterate over recursively
    	*/
    	const _sanitizeShadowDOM2 = function _sanitizeShadowDOM(fragment) {
    		let shadowNode = null;
    		const shadowIterator = _createNodeIterator(fragment);
    		_executeHooks(hooks.beforeSanitizeShadowDOM, fragment, null);
    		while (shadowNode = shadowIterator.nextNode()) {
    			_executeHooks(hooks.uponSanitizeShadowNode, shadowNode, null);
    			_sanitizeElements(shadowNode, fragment);
    			_sanitizeAttributes(shadowNode, fragment);
    			if (_isDocumentFragment(shadowNode.content)) _sanitizeShadowDOM2(shadowNode.content);
    			if (_readNodeType(shadowNode) === NODE_TYPE.element) {
    				const innerSr = getShadowRoot(shadowNode);
    				if (_isDocumentFragment(innerSr)) {
    					_sanitizeAttachedShadowRoots(innerSr);
    					_sanitizeShadowDOM2(innerSr);
    				}
    			}
    		}
    		_executeHooks(hooks.afterSanitizeShadowDOM, fragment, null);
    	};
    	/**
    	* _sanitizeAttachedShadowRoots
    	*
    	* Walks `root` and feeds every attached shadow root we encounter into
    	* the existing _sanitizeShadowDOM pipeline. The default node iterator
    	* does not descend into shadow trees, so nodes inside an attached
    	* shadow root would otherwise be skipped entirely.
    	*
    	* Two real input paths put attached shadow roots in front of us:
    	*   1. IN_PLACE on a DOM node that already has shadow roots attached.
    	*   2. DOM-node input where importNode(dirty, true) deep-clones the
    	*      shadow root because it was created with `clonable: true`.
    	*
    	* This pass runs once, up front, so the main iteration loop (and the
    	* existing _sanitizeShadowDOM template-content recursion) stay
    	* untouched — string-input paths are not affected.
    	*
    	* @param root the subtree root to walk for attached shadow roots
    	*/
    	const _sanitizeAttachedShadowRoots = function _sanitizeAttachedShadowRoots(root) {
    		const stack = [{
    			node: root,
    			shadow: null
    		}];
    		while (stack.length > 0) {
    			const item = stack.pop();
    			if (item.shadow) {
    				_sanitizeShadowDOM2(item.shadow);
    				continue;
    			}
    			const node = item.node;
    			const isElement = _readNodeType(node) === NODE_TYPE.element;
    			const childNodes = getChildNodes(node);
    			if (childNodes) for (let i = childNodes.length - 1; i >= 0; --i) stack.push({
    				node: childNodes[i],
    				shadow: null
    			});
    			if (isElement) {
    				const rootName = getNodeName ? getNodeName(node) : null;
    				if (typeof rootName === "string" && transformCaseFunc(rootName) === "template") {
    					const content = node.content;
    					if (_isDocumentFragment(content)) stack.push({
    						node: content,
    						shadow: null
    					});
    				}
    			}
    			if (isElement) {
    				const sr = getShadowRoot(node);
    				if (_isDocumentFragment(sr)) stack.push({
    					node: null,
    					shadow: sr
    				}, {
    					node: sr,
    					shadow: null
    				});
    			}
    		}
    	};
    	DOMPurify.sanitize = function(dirty) {
    		let cfg = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {};
    		let body = null;
    		let importedNode = null;
    		let currentNode = null;
    		let returnNode = null;
    		IS_EMPTY_INPUT = !dirty;
    		if (IS_EMPTY_INPUT) dirty = "<!-->";
    		if (typeof dirty !== "string" && !_isNode(dirty)) {
    			dirty = stringifyValue(dirty);
    			if (typeof dirty !== "string") throw typeErrorCreate("dirty is not a string, aborting");
    		}
    		if (!DOMPurify.isSupported) return dirty;
    		if (SET_CONFIG) {
    			ALLOWED_TAGS = SET_CONFIG_ALLOWED_TAGS;
    			ALLOWED_ATTR = SET_CONFIG_ALLOWED_ATTR;
    		} else _parseConfig(cfg);
    		if (hooks.uponSanitizeElement.length > 0 || hooks.uponSanitizeAttribute.length > 0) ALLOWED_TAGS = clone(ALLOWED_TAGS);
    		if (hooks.uponSanitizeAttribute.length > 0) ALLOWED_ATTR = clone(ALLOWED_ATTR);
    		DOMPurify.removed = [];
    		const inPlace = IN_PLACE && typeof dirty !== "string" && _isNode(dirty);
    		if (inPlace) {
    			_neutralizePatchLinkage(dirty);
    			const nn = _readNodeName(dirty);
    			if (typeof nn === "string") {
    				const tagName = transformCaseFunc(nn);
    				if (!ALLOWED_TAGS[tagName] || FORBID_TAGS[tagName]) {
    					_neutralizeRoot(dirty);
    					throw typeErrorCreate("root node is forbidden and cannot be sanitized in-place");
    				}
    			}
    			if (_isClobbered(dirty)) {
    				_neutralizeRoot(dirty);
    				throw typeErrorCreate("root node is clobbered and cannot be sanitized in-place");
    			}
    			try {
    				_sanitizeAttachedShadowRoots(dirty);
    			} catch (error) {
    				_neutralizeRoot(dirty);
    				throw error;
    			}
    		} else if (_isNode(dirty)) {
    			body = _initDocument("<!---->");
    			importedNode = body.ownerDocument.importNode(dirty, true);
    			if (importedNode.nodeType === NODE_TYPE.element && importedNode.nodeName === "BODY") body = importedNode;
    			else if (importedNode.nodeName === "HTML") body = importedNode;
    			else body.appendChild(importedNode);
    			_sanitizeAttachedShadowRoots(body);
    		} else {
    			if (!RETURN_DOM && !SAFE_FOR_TEMPLATES && !WHOLE_DOCUMENT && dirty.indexOf("<") === -1) return trustedTypesPolicy && RETURN_TRUSTED_TYPE ? _createTrustedHTML(dirty) : dirty;
    			body = _initDocument(dirty);
    			if (!body) return RETURN_DOM ? null : RETURN_TRUSTED_TYPE ? emptyHTML : "";
    		}
    		if (body && FORCE_BODY) _forceRemove(body.firstChild);
    		const walkRoot = inPlace ? dirty : body;
    		try {
    			const nodeIterator = _createNodeIterator(walkRoot);
    			while (currentNode = nodeIterator.nextNode()) {
    				_sanitizeElements(currentNode, walkRoot);
    				_sanitizeAttributes(currentNode, walkRoot);
    				if (_isDocumentFragment(currentNode.content)) _sanitizeShadowDOM2(currentNode.content);
    			}
    		} catch (error) {
    			if (inPlace) {
    				_neutralizeRoot(dirty);
    				arrayForEach(DOMPurify.removed, (entry) => {
    					if (entry.element) _neutralizeSubtree(entry.element);
    				});
    			}
    			throw error;
    		}
    		if (inPlace) {
    			let rootWasRemoved = false;
    			arrayForEach(DOMPurify.removed, (entry) => {
    				if (entry.element) {
    					if (entry.element === dirty) rootWasRemoved = true;
    					_neutralizeSubtree(entry.element);
    				}
    			});
    			if (rootWasRemoved) throw typeErrorCreate("a node selected for removal could not be safely returned; refusing to sanitize in place");
    			if (SAFE_FOR_TEMPLATES) _scrubTemplateExpressions2(dirty);
    			return dirty;
    		}
    		if (RETURN_DOM) {
    			if (SAFE_FOR_TEMPLATES) _scrubTemplateExpressions2(body);
    			if (RETURN_DOM_FRAGMENT) {
    				returnNode = createDocumentFragment.call(body.ownerDocument);
    				while (body.firstChild) returnNode.appendChild(body.firstChild);
    			} else returnNode = body;
    			if (ALLOWED_ATTR.shadowroot || ALLOWED_ATTR.shadowrootmode) returnNode = importNode.call(originalDocument, returnNode, true);
    			return returnNode;
    		}
    		let serializedHTML = WHOLE_DOCUMENT ? body.outerHTML : body.innerHTML;
    		if (WHOLE_DOCUMENT && ALLOWED_TAGS["!doctype"] && body.ownerDocument && body.ownerDocument.doctype && body.ownerDocument.doctype.name && regExpTest(DOCTYPE_NAME, body.ownerDocument.doctype.name)) serializedHTML = "<!DOCTYPE " + body.ownerDocument.doctype.name + ">\n" + serializedHTML;
    		if (SAFE_FOR_TEMPLATES) serializedHTML = _stripTemplateExpressions(serializedHTML);
    		return trustedTypesPolicy && RETURN_TRUSTED_TYPE ? _createTrustedHTML(serializedHTML) : serializedHTML;
    	};
    	DOMPurify.setConfig = function() {
    		let cfg = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    		_parseConfig(cfg);
    		SET_CONFIG = true;
    		SET_CONFIG_ALLOWED_TAGS = ALLOWED_TAGS;
    		SET_CONFIG_ALLOWED_ATTR = ALLOWED_ATTR;
    	};
    	DOMPurify.clearConfig = function() {
    		CONFIG = null;
    		SET_CONFIG = false;
    		SET_CONFIG_ALLOWED_TAGS = null;
    		SET_CONFIG_ALLOWED_ATTR = null;
    		trustedTypesPolicy = defaultTrustedTypesPolicy;
    		emptyHTML = "";
    	};
    	DOMPurify.isValidAttribute = function(tag, attr, value) {
    		if (!CONFIG) _parseConfig({});
    		const lcTag = transformCaseFunc(tag);
    		const lcName = transformCaseFunc(attr);
    		return _isValidAttribute(lcTag, lcName, value);
    	};
    	DOMPurify.addHook = function(entryPoint, hookFunction) {
    		if (typeof hookFunction !== "function") return;
    		if (!objectHasOwnProperty(hooks, entryPoint)) return;
    		arrayPush(hooks[entryPoint], hookFunction);
    	};
    	DOMPurify.removeHook = function(entryPoint, hookFunction) {
    		if (!objectHasOwnProperty(hooks, entryPoint)) return;
    		if (hookFunction !== void 0) {
    			const index = arrayLastIndexOf(hooks[entryPoint], hookFunction);
    			return index === -1 ? void 0 : arraySplice(hooks[entryPoint], index, 1)[0];
    		}
    		return arrayPop(hooks[entryPoint]);
    	};
    	DOMPurify.removeHooks = function(entryPoint) {
    		if (!objectHasOwnProperty(hooks, entryPoint)) return;
    		hooks[entryPoint] = [];
    	};
    	DOMPurify.removeAllHooks = function() {
    		hooks = _createHooksMap();
    	};
    	return DOMPurify;
    }
    var purify_default = createDOMPurify();

    let anchorHookInstalled = false;
    function ensureAnchorHook() {
        if (anchorHookInstalled)
            return;
        purify_default.addHook('afterSanitizeAttributes', (node) => {
            if (node.tagName === 'A') {
                node.setAttribute('target', '_blank');
                node.setAttribute('rel', 'noopener noreferrer');
            }
        });
        anchorHookInstalled = true;
    }
    function sanitizeHtml(html) {
        ensureAnchorHook();
        return purify_default.sanitize(html, {
            ALLOWED_TAGS: [
                // Text formatting
                'a', 'b', 'i', 'em', 'strong', 'u', 's', 'strike', 'del',
                // Paragraphs and breaks
                'p', 'br', 'div', 'span',
                // Headings
                'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                // Lists
                'ul', 'ol', 'li', 'dl', 'dt', 'dd',
                // Code
                'code', 'pre', 'kbd', 'samp',
                // Blockquotes
                'blockquote', 'q',
                // Tables
                'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
                // Images
                'img',
                // Other
                'hr', 'sub', 'sup', 'small', 'mark', 'abbr', 'cite', 'time'
            ],
            ALLOWED_ATTR: [
                'href', 'target', 'rel', 'title', 'class', 'id', 'style',
                'src', 'alt', 'width', 'height',
            ],
            ALLOW_DATA_ATTR: false,
            // Allow style attribute but sanitize it
            ALLOW_UNKNOWN_PROTOCOLS: false,
            ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,)/i,
        });
    }

    /**
     * Formats an ISO timestamp string to a human-readable format.
     * Example output: "Mar 11, 2026 at 2:30 PM"
     */
    function formatTimestamp(isoString) {
        const date = new Date(isoString);
        if (isNaN(date.getTime())) {
            return '';
        }
        const months = [
            'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
        ];
        const month = months[date.getMonth()];
        const day = date.getDate();
        const year = date.getFullYear();
        let hours = date.getHours();
        const minutes = date.getMinutes();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        const minutesStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
        return `${month} ${day}, ${year} at ${hours}:${minutesStr} ${ampm}`;
    }

    const MessagePopup = ({ message, onClose, onLinkClick, }) => {
        const [isVisible, setIsVisible] = React.useState(false);
        React.useEffect(() => {
            // Trigger animation
            setTimeout(() => setIsVisible(true), 10);
        }, []);
        const handleLinkClick = (e) => {
            e.preventDefault();
            const url = e.currentTarget.href;
            onLinkClick(url);
        };
        const sanitizedContent = sanitizeHtml(message.message);
        const messageType = message.received ? 'viewed' : 'info';
        return (React__namespace.createElement("div", { className: `journy-message-overlay ${isVisible ? 'journy-message-visible' : ''}` },
            React__namespace.createElement("div", { className: `journy-message-popup journy-message-${messageType}` },
                React__namespace.createElement("button", { className: "journy-message-close", onClick: onClose, "aria-label": "Close message" }, "\u00D7"),
                message.createdAt && (React__namespace.createElement("div", { className: "journy-message-timestamp" }, formatTimestamp(message.createdAt))),
                React__namespace.createElement("div", { className: "journy-message-content", dangerouslySetInnerHTML: { __html: sanitizedContent }, onClick: (e) => {
                        const target = e.target;
                        if (target.tagName === 'A') {
                            handleLinkClick(e);
                        }
                    } }))));
    };

    const POLLING_OPTIONS = [
        { label: '15 seconds', value: 15000 },
        { label: '30 seconds', value: 30000 },
        { label: '60 seconds', value: 60000 },
        { label: '120 seconds', value: 120000 },
    ];
    const DISPLAY_MODE_OPTIONS = [
        { label: 'Widget', value: 'widget' },
        { label: 'List', value: 'list' },
    ];
    const BANNER_POSITION_OPTIONS = [
        { label: 'Top left', value: 'top-left' },
        { label: 'Top center', value: 'top-center' },
        { label: 'Top right', value: 'top-right' },
        { label: 'Bottom left', value: 'bottom-left' },
        { label: 'Bottom center', value: 'bottom-center' },
        { label: 'Bottom right', value: 'bottom-right' },
    ];
    const BANNER_AUTO_DISMISS_OPTIONS = [
        { label: "Don't dismiss", value: 0 },
        { label: '5 seconds', value: 5000 },
        { label: '10 seconds', value: 10000 },
        { label: '20 seconds', value: 20000 },
        { label: '30 seconds', value: 30000 },
        { label: '60 seconds', value: 60000 },
    ];
    const STYLES_OPTIONS = [
        { label: 'Default', value: 'default' },
        { label: 'None (custom)', value: 'none' },
    ];
    function getStylesKey(styles) {
        if (styles === 'default' || styles === 'none')
            return styles;
        if (typeof styles === 'object' && 'url' in styles)
            return 'custom-url';
        if (typeof styles === 'object' && 'css' in styles)
            return 'custom-css';
        return 'default';
    }
    const SettingsPanel = ({ isOpen, onClose, settings, onSettingsChange, configInfo, }) => {
        const [showAdvanced, setShowAdvanced] = React.useState(false);
        // Buffer changes locally so they only commit when the user clicks "Save".
        // Reset the draft whenever the panel opens or the upstream settings change.
        const [draft, setDraft] = React.useState(settings);
        React.useEffect(() => {
            if (isOpen) {
                setDraft(settings);
            }
        }, [isOpen, settings]);
        const isDirty = React.useMemo(() => JSON.stringify(draft) !== JSON.stringify(settings), [draft, settings]);
        const update = (partial) => {
            setDraft((prev) => ({ ...prev, ...partial }));
        };
        const handleToggle = (key) => {
            update({ [key]: !draft[key] });
        };
        const handleSave = () => {
            onSettingsChange(draft);
            onClose();
        };
        const handleCancel = () => {
            setDraft(settings);
            onClose();
        };
        const stylesKey = getStylesKey(draft.styles);
        return (React__namespace.createElement("div", { className: `journy-settings-panel ${isOpen ? 'journy-settings-panel-open' : 'journy-settings-panel-closed'}`, onClick: (e) => e.stopPropagation() },
            React__namespace.createElement("div", { className: "journy-settings-header" },
                React__namespace.createElement("span", { className: "journy-settings-title" }, "Settings"),
                React__namespace.createElement("button", { type: "button", className: "journy-settings-close", onClick: handleCancel, title: "Close settings", "aria-label": "Close settings" }, "\u00D7")),
            React__namespace.createElement("div", { className: "journy-settings-body" },
                React__namespace.createElement("div", { className: "journy-settings-item" },
                    React__namespace.createElement("label", { className: "journy-settings-label" }, "Display mode"),
                    React__namespace.createElement("select", { className: "journy-settings-select", value: draft.displayMode, onChange: (e) => update({ displayMode: e.target.value }) }, DISPLAY_MODE_OPTIONS.map((opt) => (React__namespace.createElement("option", { key: opt.value, value: opt.value }, opt.label))))),
                React__namespace.createElement("div", { className: "journy-settings-item" },
                    React__namespace.createElement("label", { className: "journy-settings-label" }, "Banner position"),
                    React__namespace.createElement("select", { className: "journy-settings-select", value: draft.bannerPosition, onChange: (e) => update({ bannerPosition: e.target.value }) }, BANNER_POSITION_OPTIONS.map((opt) => (React__namespace.createElement("option", { key: opt.value, value: opt.value }, opt.label))))),
                React__namespace.createElement("div", { className: "journy-settings-item" },
                    React__namespace.createElement("label", { className: "journy-settings-label" }, "Banner auto-dismiss"),
                    React__namespace.createElement("select", { className: "journy-settings-select", value: draft.bannerAutoDismissMs, onChange: (e) => update({ bannerAutoDismissMs: Number(e.target.value) }) }, BANNER_AUTO_DISMISS_OPTIONS.map((opt) => (React__namespace.createElement("option", { key: opt.value, value: opt.value }, opt.label))))),
                React__namespace.createElement("div", { className: "journy-settings-item" },
                    React__namespace.createElement("label", { className: "journy-settings-label" }, "Polling interval"),
                    React__namespace.createElement("select", { className: "journy-settings-select", value: draft.pollingInterval, onChange: (e) => update({ pollingInterval: Number(e.target.value) }) }, POLLING_OPTIONS.map((opt) => (React__namespace.createElement("option", { key: opt.value, value: opt.value }, opt.label))))),
                React__namespace.createElement("div", { className: "journy-settings-item" },
                    React__namespace.createElement("label", { className: "journy-settings-label" }, "Show read messages"),
                    React__namespace.createElement("button", { type: "button", className: `journy-settings-toggle ${draft.showReadMessages ? 'journy-settings-toggle-on' : ''}`, onClick: () => handleToggle('showReadMessages'), role: "switch", "aria-checked": draft.showReadMessages },
                        React__namespace.createElement("span", { className: "journy-settings-toggle-knob" }))),
                React__namespace.createElement("div", { className: "journy-settings-item" },
                    React__namespace.createElement("label", { className: "journy-settings-label" }, "Auto-expand on new messages"),
                    React__namespace.createElement("button", { type: "button", className: `journy-settings-toggle ${draft.autoExpandOnNew ? 'journy-settings-toggle-on' : ''}`, onClick: () => handleToggle('autoExpandOnNew'), role: "switch", "aria-checked": draft.autoExpandOnNew },
                        React__namespace.createElement("span", { className: "journy-settings-toggle-knob" }))),
                React__namespace.createElement("div", { className: "journy-settings-item" },
                    React__namespace.createElement("label", { className: "journy-settings-label" }, "Styles"),
                    React__namespace.createElement("select", { className: "journy-settings-select", value: stylesKey, onChange: (e) => {
                            const val = e.target.value;
                            if (val === 'default' || val === 'none') {
                                update({ styles: val });
                            }
                        } },
                        STYLES_OPTIONS.map((opt) => (React__namespace.createElement("option", { key: opt.value, value: opt.value }, opt.label))),
                        stylesKey === 'custom-url' && (React__namespace.createElement("option", { value: "custom-url", disabled: true }, "Custom URL")),
                        stylesKey === 'custom-css' && (React__namespace.createElement("option", { value: "custom-css", disabled: true }, "Custom CSS")))),
                React__namespace.createElement("div", { className: "journy-settings-item" },
                    React__namespace.createElement("button", { type: "button", className: "journy-settings-advanced-btn", onClick: () => setShowAdvanced(!showAdvanced) }, showAdvanced ? '▾ Advanced' : '▸ Advanced')),
                showAdvanced && (React__namespace.createElement(React__namespace.Fragment, null,
                    React__namespace.createElement("div", { className: "journy-settings-item journy-settings-item-vertical" },
                        React__namespace.createElement("label", { className: "journy-settings-label" }, "API endpoint"),
                        React__namespace.createElement("input", { type: "text", className: "journy-settings-input", value: draft.apiEndpoint, onChange: (e) => update({ apiEndpoint: e.target.value }), placeholder: DEFAULT_API_ENDPOINT })),
                    configInfo && (React__namespace.createElement(React__namespace.Fragment, null,
                        React__namespace.createElement("div", { className: "journy-settings-item" },
                            React__namespace.createElement("label", { className: "journy-settings-label" }, "Entity type"),
                            React__namespace.createElement("span", { className: "journy-settings-value" }, configInfo.entityType)),
                        configInfo.userId && (React__namespace.createElement("div", { className: "journy-settings-item" },
                            React__namespace.createElement("label", { className: "journy-settings-label" }, "User ID"),
                            React__namespace.createElement("span", { className: "journy-settings-value" }, configInfo.userId))),
                        configInfo.accountId && (React__namespace.createElement("div", { className: "journy-settings-item" },
                            React__namespace.createElement("label", { className: "journy-settings-label" }, "Account ID"),
                            React__namespace.createElement("span", { className: "journy-settings-value" }, configInfo.accountId)))))))),
            React__namespace.createElement("div", { className: "journy-settings-footer" },
                React__namespace.createElement("button", { type: "button", className: "journy-settings-btn journy-settings-btn-secondary", onClick: handleCancel }, "Cancel"),
                React__namespace.createElement("button", { type: "button", className: "journy-settings-btn journy-settings-btn-primary", onClick: handleSave, disabled: !isDirty }, "Save"))));
    };

    const defaultContext = {
        targetWindow: typeof window !== 'undefined' ? window : null,
        targetDocument: typeof document !== 'undefined' ? document : null,
        isRemote: false,
        sourceWindow: typeof window !== 'undefined' ? window : null,
    };
    const RenderCtx = React__namespace.createContext(defaultContext);
    function useRenderContext() {
        return React__namespace.useContext(RenderCtx);
    }

    const COLLAPSED_WIDTH = 160;
    const COLLAPSED_HEIGHT = 44;
    const WIDGET_MODE_EXPANDED_WIDTH = 340;
    const WIDGET_MODE_EXPANDED_HEIGHT = 280;
    const LIST_MODE_DEFAULT_WIDTH = 600;
    const LIST_MODE_DEFAULT_HEIGHT = 800;
    const DEFAULT_EDGE_OFFSET = 20;
    const VIEWPORT_PADDING = 40;
    const MIN_LIST_WIDTH = 300;
    const MIN_LIST_HEIGHT = 200;
    function useWidgetDragResize({ isCollapsed, isListMode }) {
        const { targetWindow, targetDocument } = useRenderContext();
        // Collapsed pill position — persisted independently, defaults to bottom-right corner
        const [collapsedPosition, setCollapsedPosition] = React.useState(() => {
            const saved = getItem('widget_collapsed_position');
            if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
                return {
                    left: Math.max(0, Math.min(saved.left, targetWindow.innerWidth - COLLAPSED_WIDTH)),
                    top: Math.max(0, Math.min(saved.top, targetWindow.innerHeight - COLLAPSED_HEIGHT)),
                };
            }
            return {
                left: targetWindow.innerWidth - DEFAULT_EDGE_OFFSET - COLLAPSED_WIDTH,
                top: targetWindow.innerHeight - DEFAULT_EDGE_OFFSET - COLLAPSED_HEIGHT,
            };
        });
        const [size, setSize] = React.useState(() => {
            const savedSize = getItem('widget_size');
            if (savedSize) {
                return {
                    width: Math.max(MIN_LIST_WIDTH, Math.min(savedSize.width, targetWindow.innerWidth - VIEWPORT_PADDING)),
                    height: Math.max(MIN_LIST_HEIGHT, Math.min(savedSize.height, targetWindow.innerHeight - VIEWPORT_PADDING)),
                };
            }
            return { width: LIST_MODE_DEFAULT_WIDTH, height: LIST_MODE_DEFAULT_HEIGHT };
        });
        // Compute expanded dimensions here so expandedPosition initializer can use them
        const expandedWidth = isListMode ? size.width : WIDGET_MODE_EXPANDED_WIDTH;
        const expandedHeight = isListMode ? size.height : WIDGET_MODE_EXPANDED_HEIGHT;
        // Expanded widget position — persisted independently, defaults to anchored off the collapsed pill
        const [expandedPosition, setExpandedPosition] = React.useState(() => {
            const saved = getItem('widget_position');
            if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
                return {
                    left: Math.max(0, Math.min(saved.left, targetWindow.innerWidth - expandedWidth)),
                    top: Math.max(0, Math.min(saved.top, targetWindow.innerHeight - expandedHeight)),
                };
            }
            // Anchor bottom-right of expanded widget to bottom-right of collapsed pill
            const right = collapsedPosition.left + COLLAPSED_WIDTH;
            const bottom = collapsedPosition.top + COLLAPSED_HEIGHT;
            return {
                left: Math.max(0, Math.min(right - expandedWidth, targetWindow.innerWidth - expandedWidth)),
                top: Math.max(0, Math.min(bottom - expandedHeight, targetWindow.innerHeight - expandedHeight)),
            };
        });
        const [isDragging, setIsDragging] = React.useState(false);
        const [isResizing, setIsResizing] = React.useState(false);
        const [dragOffset, setDragOffset] = React.useState({ x: 0, y: 0 });
        const [resizeStart, setResizeStart] = React.useState(null);
        const widgetRef = React.useRef(null);
        const hasDraggedThisSession = React.useRef(false);
        const justFinishedDragging = React.useRef(false);
        // Keep a ref so the drag mousemove handler always sees the current collapsed state
        const isCollapsedRef = React.useRef(isCollapsed);
        React.useEffect(() => {
            isCollapsedRef.current = isCollapsed;
        }, [isCollapsed]);
        const currentWidth = isCollapsed ? COLLAPSED_WIDTH : expandedWidth;
        const currentHeight = isCollapsed ? COLLAPSED_HEIGHT : expandedHeight;
        // The position exposed to the widget: collapsed pill pos or expanded widget pos
        const position = isCollapsed ? collapsedPosition : expandedPosition;
        // Clamp expanded position when expanded dimensions change
        React.useEffect(() => {
            setExpandedPosition(prev => ({
                left: Math.max(0, Math.min(prev.left, targetWindow.innerWidth - expandedWidth)),
                top: Math.max(0, Math.min(prev.top, targetWindow.innerHeight - expandedHeight)),
            }));
        }, [expandedWidth, expandedHeight, targetWindow]);
        // Clamp collapsed position on viewport change
        React.useEffect(() => {
            setCollapsedPosition(prev => ({
                left: Math.max(0, Math.min(prev.left, targetWindow.innerWidth - COLLAPSED_WIDTH)),
                top: Math.max(0, Math.min(prev.top, targetWindow.innerHeight - COLLAPSED_HEIGHT)),
            }));
        }, [targetWindow]);
        // Persist collapsed position
        React.useEffect(() => {
            setItem('widget_collapsed_position', collapsedPosition);
        }, [collapsedPosition]);
        // Persist expanded position
        React.useEffect(() => {
            setItem('widget_position', expandedPosition);
        }, [expandedPosition]);
        // Persist size (list mode expanded only)
        React.useEffect(() => {
            if (isListMode && !isCollapsed && size.width > 0 && size.height > 0) {
                setItem('widget_size', size);
            }
        }, [size, isCollapsed, isListMode]);
        // Constrain both positions when window resizes
        React.useEffect(() => {
            const handleResize = () => {
                setExpandedPosition(prev => ({
                    left: Math.max(0, Math.min(prev.left, targetWindow.innerWidth - expandedWidth)),
                    top: Math.max(0, Math.min(prev.top, targetWindow.innerHeight - expandedHeight)),
                }));
                setCollapsedPosition(prev => ({
                    left: Math.max(0, Math.min(prev.left, targetWindow.innerWidth - COLLAPSED_WIDTH)),
                    top: Math.max(0, Math.min(prev.top, targetWindow.innerHeight - COLLAPSED_HEIGHT)),
                }));
            };
            targetWindow.addEventListener('resize', handleResize);
            return () => targetWindow.removeEventListener('resize', handleResize);
        }, [expandedWidth, expandedHeight, targetWindow]);
        const handleMouseDown = (e) => {
            const target = e.target;
            if (!target.closest('.journy-message-widget-header'))
                return;
            if (target.closest('button') || target.closest('a'))
                return;
            if (!widgetRef.current)
                return;
            hasDraggedThisSession.current = false;
            const rect = widgetRef.current.getBoundingClientRect();
            setDragOffset({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
            });
            setIsDragging(true);
        };
        // Global mousemove/mouseup for drag and resize
        React.useEffect(() => {
            if (!isDragging && !isResizing)
                return;
            const handleMouseMove = (e) => {
                if (isDragging) {
                    hasDraggedThisSession.current = true;
                    const newLeft = e.clientX - dragOffset.x;
                    const newTop = e.clientY - dragOffset.y;
                    if (isCollapsedRef.current) {
                        setCollapsedPosition({
                            left: Math.max(0, Math.min(newLeft, targetWindow.innerWidth - COLLAPSED_WIDTH)),
                            top: Math.max(0, Math.min(newTop, targetWindow.innerHeight - COLLAPSED_HEIGHT)),
                        });
                    }
                    else {
                        setExpandedPosition({
                            left: Math.max(0, Math.min(newLeft, targetWindow.innerWidth - expandedWidth)),
                            top: Math.max(0, Math.min(newTop, targetWindow.innerHeight - expandedHeight)),
                        });
                    }
                }
                else if (isResizing && resizeStart) {
                    const deltaX = e.clientX - resizeStart.x;
                    const deltaY = e.clientY - resizeStart.y;
                    const maxWidth = targetWindow.innerWidth - expandedPosition.left;
                    const maxHeight = targetWindow.innerHeight - expandedPosition.top;
                    const newWidth = Math.max(MIN_LIST_WIDTH, Math.min(resizeStart.width + deltaX, maxWidth));
                    const newHeight = Math.max(MIN_LIST_HEIGHT, Math.min(resizeStart.height + deltaY, maxHeight));
                    setSize({ width: newWidth, height: newHeight });
                }
            };
            const handleMouseUp = () => {
                if (isDragging && hasDraggedThisSession.current) {
                    justFinishedDragging.current = true;
                    setTimeout(() => {
                        justFinishedDragging.current = false;
                    }, 100);
                }
                setIsDragging(false);
                setIsResizing(false);
                setResizeStart(null);
            };
            targetDocument.addEventListener('mousemove', handleMouseMove);
            targetDocument.addEventListener('mouseup', handleMouseUp);
            return () => {
                targetDocument.removeEventListener('mousemove', handleMouseMove);
                targetDocument.removeEventListener('mouseup', handleMouseUp);
            };
        }, [isDragging, isResizing, dragOffset, resizeStart, expandedPosition, expandedWidth, expandedHeight, targetDocument, targetWindow]);
        const handleResizeStart = (e) => {
            e.stopPropagation();
            if (!widgetRef.current)
                return;
            const rect = widgetRef.current.getBoundingClientRect();
            setResizeStart({
                x: e.clientX,
                y: e.clientY,
                width: rect.width,
                height: rect.height,
            });
            setIsResizing(true);
        };
        return {
            position,
            size,
            isDragging,
            isResizing,
            widgetRef,
            justFinishedDragging,
            currentWidth,
            currentHeight,
            handleMouseDown,
            handleResizeStart,
        };
    }
    const TRANSITION_DURATION_S = 0.25;

    const DragHandle = ({ onMouseDown, title = 'Drag to move', className = 'journy-message-widget-drag-handle', }) => (React__namespace.createElement("div", { className: className, onMouseDown: onMouseDown, title: title },
        React__namespace.createElement("svg", { viewBox: "0 0 684 684", xmlns: "http://www.w3.org/2000/svg", width: "20", height: "20" },
            React__namespace.createElement("g", { fill: "none" },
                React__namespace.createElement("circle", { cx: "342", cy: "342", fill: "#fff", r: "342" }),
                React__namespace.createElement("circle", { cx: "343.5", cy: "343.5", fill: "#f2994a", r: "156.5" }),
                React__namespace.createElement("path", { d: "m344 68c151.878306 0 275 123.121694 275 275s-123.121694 275-275 275-275-123.121694-275-275 123.121694-275 275-275zm.5 46c-126.74935 0-229.5 102.75065-229.5 229.5s102.75065 229.5 229.5 229.5 229.5-102.75065 229.5-229.5-102.75065-229.5-229.5-229.5z", fill: "#528afa" })))));

    function getMessageTitle(msg) {
        if (!msg)
            return 'Messages';
        const match = msg.message.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/i);
        return match ? match[1].replace(/<[^>]+>/g, '') : 'Messages';
    }
    /** Widget header: drag handle, title/badge area (collapsed vs expanded), and control buttons. */
    const WidgetHeader = ({ isCollapsed, isListMode, unreadCount, displayMessage, allMessagesToShow, onToggleExpand, onClose, onCloseWidget, onOpenSettings, handleMouseDown, }) => {
        if (isCollapsed) {
            return (React__namespace.createElement("div", { className: "journy-message-widget-header journy-message-widget-header--pill", onMouseDown: handleMouseDown },
                React__namespace.createElement("div", { className: "journy-message-widget-logo-wrapper" },
                    React__namespace.createElement(DragHandle, null),
                    unreadCount > 0 && (React__namespace.createElement("span", { className: "journy-message-widget-logo-badge" }, unreadCount))),
                React__namespace.createElement("span", { className: "journy-message-widget-pill-title" }, "Messages"),
                React__namespace.createElement("div", { className: "journy-message-widget-avatar-slot" },
                    React__namespace.createElement("button", { type: "button", className: "journy-message-widget-close journy-message-widget-close--pill", onClick: (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            onCloseWidget ? onCloseWidget() : onClose();
                        }, onMouseDown: (e) => e.stopPropagation(), title: "Close widget", "aria-label": "Close" }, "\u00D7"))));
        }
        return (React__namespace.createElement("div", { className: "journy-message-widget-header", onMouseDown: handleMouseDown },
            React__namespace.createElement(DragHandle, null),
            React__namespace.createElement("div", { className: "journy-message-widget-header-content" },
                unreadCount > 0 && (React__namespace.createElement("span", { className: "journy-message-widget-badge" }, unreadCount)),
                React__namespace.createElement("span", { className: "journy-message-widget-title" }, displayMessage
                    ? getMessageTitle(displayMessage)
                    : allMessagesToShow.length > 0
                        ? getMessageTitle(allMessagesToShow[0])
                        : 'Messages'),
                isListMode && allMessagesToShow.length > 1 && (React__namespace.createElement("span", { className: "journy-message-widget-message-count" },
                    "(",
                    allMessagesToShow.length,
                    " messages)"))),
            React__namespace.createElement("div", { className: "journy-message-widget-controls" },
                isDebugSettings() && (React__namespace.createElement("button", { type: "button", className: "journy-message-widget-settings-btn", onClick: (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        onOpenSettings();
                    }, onMouseDown: (e) => e.stopPropagation(), title: "Settings", "aria-label": "Settings" },
                    React__namespace.createElement("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
                        React__namespace.createElement("path", { d: "M6.5 1L6.2 2.6C5.8 2.8 5.5 3 5.2 3.2L3.6 2.7L2.1 5.3L3.4 6.3C3.4 6.5 3.3 6.8 3.3 7C3.3 7.2 3.4 7.5 3.4 7.7L2.1 8.7L3.6 11.3L5.2 10.8C5.5 11 5.8 11.2 6.2 11.4L6.5 13H9.5L9.8 11.4C10.2 11.2 10.5 11 10.8 10.8L12.4 11.3L13.9 8.7L12.6 7.7C12.6 7.5 12.7 7.2 12.7 7C12.7 6.8 12.6 6.5 12.6 6.3L13.9 5.3L12.4 2.7L10.8 3.2C10.5 3 10.2 2.8 9.8 2.6L9.5 1H6.5ZM8 5C9.1 5 10 5.9 10 7C10 8.1 9.1 9 8 9C6.9 9 6 8.1 6 7C6 5.9 6.9 5 8 5Z", fill: "currentColor" })))),
                React__namespace.createElement("button", { type: "button", className: "journy-message-widget-toggle", onClick: (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        onToggleExpand();
                    }, onMouseDown: (e) => {
                        e.stopPropagation();
                    }, title: "Collapse", "aria-label": "Collapse" }, "\u2212"),
                React__namespace.createElement("button", { type: "button", className: "journy-message-widget-close", onClick: (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        onCloseWidget ? onCloseWidget() : onClose();
                    }, onMouseDown: (e) => {
                        e.stopPropagation();
                    }, title: "Close widget", "aria-label": "Close" }, "\u00D7"))));
    };

    /** Stagger delay (ms) between marking each message as received for a sequential read effect. */
    const READ_RECEIPT_STAGGER_MS = 800;
    /** Minimum fraction of a message that must be visible in the scroll container to count as "read". */
    const READ_VISIBILITY_THRESHOLD = 0.5;
    /** Shared counter so multiple messages becoming visible at the same time get sequential delays. */
    const getNextVisibilityDelay = (() => {
        let counter = 0;
        let resetTimer = null;
        // Reset counter after a quiet period so future batches start from 0
        return () => {
            const order = counter++;
            if (resetTimer)
                clearTimeout(resetTimer);
            resetTimer = setTimeout(() => { counter = 0; }, 3000);
            return order * READ_RECEIPT_STAGGER_MS;
        };
    })();
    /**
     * Mark message as received when its element is visible in the viewport.
     * A staggered delay is applied so messages appear to be read one-by-one
     * rather than all at once.
     * When running inside an iframe without remote rendering (renderTarget: 'self'),
     * the IntersectionObserver would use the tiny iframe viewport and fire immediately,
     * so we skip it and rely on explicit user interactions instead.
     */
    function useMessageVisibility(ref, messageId, received, onMessageReceived, scrollRoot) {
        const { isRemote } = useRenderContext();
        const hasFiredRef = React.useRef(false);
        React.useEffect(() => {
            if (received) {
                hasFiredRef.current = true;
                return;
            }
            hasFiredRef.current = false;
            const el = ref.current;
            if (!el || !onMessageReceived)
                return;
            // When a scrollRoot is provided (e.g. the widget's own scrollable list container),
            // the observer is scoped to that container — messages must actually scroll into
            // view inside the widget to be marked as read.
            // Without a scrollRoot, fall back to the browser viewport but skip the observer
            // when inside an iframe without remote rendering (iframe viewport causes false positives).
            const root = scrollRoot?.current ?? null;
            if (!root) {
                let isInIframe;
                try {
                    isInIframe = window !== window.top;
                }
                catch {
                    isInIframe = true;
                }
                if (isInIframe && !isRemote)
                    return;
            }
            let delayTimer = null;
            /** Returns the fraction of `el` currently visible inside `root` (0–1). */
            const currentVisibilityRatio = () => {
                const elRect = el.getBoundingClientRect();
                const rootRect = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
                const visiblePx = Math.min(elRect.bottom, rootRect.bottom) - Math.max(elRect.top, rootRect.top);
                return elRect.height > 0 ? Math.max(0, visiblePx) / elRect.height : 0;
            };
            const observer = new IntersectionObserver((entries) => {
                const [entry] = entries;
                if (entry?.isIntersecting && !hasFiredRef.current) {
                    hasFiredRef.current = true;
                    observer.disconnect();
                    const delay = getNextVisibilityDelay();
                    delayTimer = setTimeout(() => {
                        // Re-verify the message is still meaningfully visible when the delay fires.
                        // Scroll momentum can briefly push a message past the threshold; if the user
                        // has already scrolled away, don't mark it as read.
                        if (currentVisibilityRatio() >= READ_VISIBILITY_THRESHOLD) {
                            onMessageReceived([messageId]);
                        }
                        else {
                            hasFiredRef.current = false;
                        }
                    }, delay);
                }
            }, { threshold: READ_VISIBILITY_THRESHOLD, root });
            observer.observe(el);
            return () => {
                observer.disconnect();
                if (delayTimer)
                    clearTimeout(delayTimer);
            };
        }, [messageId, received, onMessageReceived, isRemote, scrollRoot]);
    }

    /** Wraps a message row with a ref and viewport visibility observer to mark as received when visible. */
    const MessageRow = ({ message, isSeparated, onMessageReceived, onDismissMessage, scrollRoot, children }) => {
        const ref = React.useRef(null);
        useMessageVisibility(ref, message.id, message.received, onMessageReceived, scrollRoot);
        return (React__namespace.createElement("div", { ref: ref, className: `journy-message-widget-message journy-message-${message.received ? 'viewed' : 'info'} ${isSeparated ? 'journy-message-widget-message-separated' : ''}` },
            onDismissMessage && (React__namespace.createElement("button", { type: "button", className: "journy-message-widget-message-close", onClick: (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onDismissMessage(message.id);
                }, title: "Dismiss message", "aria-label": "Dismiss" }, "\u00D7")),
            children));
    };

    /** Renders sanitized message HTML content and optional timestamp. */
    const MessageRenderer = ({ message, onClick }) => (React__namespace.createElement(React__namespace.Fragment, null,
        React__namespace.createElement("div", { className: "journy-message-content journy-message-content-clickable", dangerouslySetInnerHTML: { __html: sanitizeHtml(message.message) }, onClick: onClick }),
        message.createdAt && (React__namespace.createElement("div", { className: "journy-message-timestamp" }, formatTimestamp(message.createdAt)))));

    const ICON_SIZE = 16;
    const STROKE_WIDTH = 1.5;
    /** Diagonal from top-right to bottom-left (resize corner). */
    const PATH_MAIN = 'M16 0 L0 16';
    const PATH_INNER = 'M13 3 L3 13';
    const ResizeHandle = ({ onMouseDown, title = 'Resize', className = 'journy-message-widget-resize-handle', }) => (React__namespace.createElement("div", { className: className, onMouseDown: onMouseDown, title: title },
        React__namespace.createElement("svg", { width: ICON_SIZE, height: ICON_SIZE, viewBox: `0 0 ${ICON_SIZE} ${ICON_SIZE}`, fill: "none", xmlns: "http://www.w3.org/2000/svg" },
            React__namespace.createElement("path", { d: `${PATH_MAIN} ${PATH_INNER}`, stroke: "#9ca3af", strokeWidth: STROKE_WIDTH, strokeLinecap: "round" }))));

    /** Renders the expanded list-mode content: scrollable message list (or empty state) + resize handle. */
    const WidgetListView = ({ messages, contentRef, isEmpty, onMessageReceived, onDismissMessage, onContentClick, handleResizeStart, }) => (React__namespace.createElement(React__namespace.Fragment, null,
        isEmpty ? (React__namespace.createElement("div", { className: "journy-message-widget-content journy-message-widget-empty" },
            React__namespace.createElement("p", null, "No unread messages"))) : (React__namespace.createElement("div", { ref: contentRef, className: "journy-message-widget-content" }, messages.map((message, index) => (React__namespace.createElement(MessageRow, { key: message.id, message: message, isSeparated: index < messages.length - 1, onMessageReceived: onMessageReceived, onDismissMessage: onDismissMessage, scrollRoot: contentRef },
            React__namespace.createElement(MessageRenderer, { message: message, onClick: (e) => onContentClick(message, e) })))))),
        React__namespace.createElement(ResizeHandle, { onMouseDown: handleResizeStart })));

    /** Renders the expanded single/widget-mode content: one message at a time with prev/next navigation. */
    const WidgetSingleView = ({ displayMessage, allMessagesToShow, currentMessageIndex, canGoPrev, canGoNext, onMessageReceived, onDismissMessage, onContentClick, onPrevMessage, onNextMessage, }) => (React__namespace.createElement(React__namespace.Fragment, null,
        React__namespace.createElement("div", { className: "journy-message-widget-content journy-message-widget-content--single" }, displayMessage ? (React__namespace.createElement(MessageRow, { message: displayMessage, isSeparated: false, onMessageReceived: onMessageReceived, onDismissMessage: onDismissMessage },
            React__namespace.createElement(MessageRenderer, { message: displayMessage, onClick: (e) => onContentClick(displayMessage, e) }))) : null),
        allMessagesToShow.length > 1 && (React__namespace.createElement("div", { className: "journy-message-widget-position" },
            React__namespace.createElement("button", { type: "button", className: "journy-message-widget-nav", onClick: (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onPrevMessage?.();
                }, title: "Previous message", "aria-label": "Previous", disabled: !canGoPrev }, "\u2039"),
            React__namespace.createElement("span", { className: "journy-message-widget-position-text" },
                currentMessageIndex + 1,
                " / ",
                allMessagesToShow.length),
            React__namespace.createElement("button", { type: "button", className: "journy-message-widget-nav", onClick: (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onNextMessage?.();
                }, title: "Next message", "aria-label": "Next", disabled: !canGoNext }, "\u203A")))));

    const PIN_PATH = 'M5 2 H11 V4 H10 V8 L12 10 V11 H9 L8.5 15 L8 16 L7.5 15 L7 11 H4 V10 L6 8 V4 H5 Z';
    const PinIcon = ({ pinned, size = 14 }) => (React__namespace.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: pinned ? 'currentColor' : 'none', stroke: "currentColor", strokeWidth: pinned ? 0 : 1.25, strokeLinejoin: "round", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", focusable: "false" },
        React__namespace.createElement("path", { d: PIN_PATH })));

    const DRAG_CLICK_THRESHOLD_PX = 4;
    const BannerView = ({ message, position, autoDismissMs, onDismissMessage, onMessageReceived, onLinkClick, }) => {
        const dismissDelayMs = autoDismissMs ?? BANNER_AUTO_DISMISS_MS;
        const isAutoDismissEnabled = dismissDelayMs > 0;
        const dismissTimerRef = React.useRef(null);
        const fadeOutTimerRef = React.useRef(null);
        const isHoveredRef = React.useRef(false);
        const isPinnedRef = React.useRef(false);
        const receivedFiredForIdRef = React.useRef(null);
        const isDismissingRef = React.useRef(false);
        const bannerRef = React.useRef(null);
        const dragStateRef = React.useRef(null);
        const dragListenersRef = React.useRef(null);
        const [isPinned, setIsPinned] = React.useState(false);
        const [isExiting, setIsExiting] = React.useState(false);
        const [dragPos, setDragPos] = React.useState(null);
        // Mirror the pinned state into a ref so timer logic always reads the latest value
        React.useEffect(() => {
            isPinnedRef.current = isPinned;
        }, [isPinned]);
        const clearDismissTimer = React.useCallback(() => {
            if (dismissTimerRef.current) {
                clearTimeout(dismissTimerRef.current);
                dismissTimerRef.current = null;
            }
        }, []);
        const clearFadeOutTimer = () => {
            if (fadeOutTimerRef.current) {
                clearTimeout(fadeOutTimerRef.current);
                fadeOutTimerRef.current = null;
            }
        };
        const triggerDismiss = React.useCallback((messageId) => {
            if (isDismissingRef.current)
                return;
            if (!onDismissMessage)
                return;
            isDismissingRef.current = true;
            clearDismissTimer();
            setIsExiting(true);
            fadeOutTimerRef.current = setTimeout(() => {
                onDismissMessage(messageId);
            }, BANNER_FADE_OUT_MS);
        }, [clearDismissTimer, onDismissMessage]);
        const startDismissTimer = React.useCallback(() => {
            clearDismissTimer();
            if (!isAutoDismissEnabled)
                return;
            if (isHoveredRef.current)
                return;
            if (isPinnedRef.current)
                return;
            if (isDismissingRef.current)
                return;
            dismissTimerRef.current = setTimeout(() => {
                triggerDismiss(message.id);
            }, dismissDelayMs);
        }, [clearDismissTimer, dismissDelayMs, isAutoDismissEnabled, message.id, triggerDismiss]);
        // Reset state when a different banner takes over the slot.
        React.useEffect(() => {
            isDismissingRef.current = false;
            setIsExiting(false);
            setIsPinned(false);
            setDragPos(null);
        }, [message.id]);
        React.useEffect(() => {
            if (receivedFiredForIdRef.current === message.id)
                return;
            receivedFiredForIdRef.current = message.id;
            if (message.received)
                return;
            onMessageReceived?.([message.id]);
        }, [message.id, message.received, onMessageReceived]);
        React.useEffect(() => {
            startDismissTimer();
            return () => {
                clearDismissTimer();
                clearFadeOutTimer();
            };
        }, [message.id, dismissDelayMs, isAutoDismissEnabled, startDismissTimer, clearDismissTimer]);
        // Restart the timer when pin state changes.
        React.useEffect(() => {
            if (!isPinned)
                startDismissTimer();
            else
                clearDismissTimer();
        }, [isPinned, startDismissTimer, clearDismissTimer]);
        const handleMouseEnter = () => {
            isHoveredRef.current = true;
            clearDismissTimer();
        };
        const handleMouseLeave = () => {
            isHoveredRef.current = false;
            startDismissTimer();
        };
        const detachDragListeners = React.useCallback(() => {
            const listeners = dragListenersRef.current;
            if (!listeners)
                return;
            document.removeEventListener('mousemove', listeners.onMove);
            document.removeEventListener('mouseup', listeners.onUp);
            dragListenersRef.current = null;
        }, []);
        // Detach any in-flight drag listeners when the banner unmounts or swaps.
        React.useEffect(() => {
            return () => {
                detachDragListeners();
                dragStateRef.current = null;
            };
        }, [message.id, detachDragListeners]);
        const handleContentClick = (e) => {
            // If the click landed on a link, let it through and don't toggle pin.
            const target = e.target;
            const anchor = target.closest('a');
            if (anchor) {
                e.stopPropagation();
                const href = anchor.getAttribute('href');
                if (href && onLinkClick)
                    onLinkClick(href);
                return;
            }
            // If the user dragged the banner, suppress the click.
            if (dragStateRef.current?.moved)
                return;
            setIsPinned((p) => !p);
        };
        const handleDragMouseDown = (e) => {
            const target = e.target;
            // Don't initiate drag from the close button, content links, or images.
            if (target.closest('.journy-message-banner-close'))
                return;
            if (target.closest('a'))
                return;
            if (target.tagName === 'IMG')
                return;
            const rect = bannerRef.current?.getBoundingClientRect();
            if (!rect)
                return;
            dragStateRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                originLeft: rect.left,
                originTop: rect.top,
                moved: false,
            };
            // Switch to absolute positioning the moment drag begins.
            setDragPos({ left: rect.left, top: rect.top });
            const onMove = (ev) => {
                const st = dragStateRef.current;
                if (!st)
                    return;
                const dx = ev.clientX - st.startX;
                const dy = ev.clientY - st.startY;
                if (!st.moved &&
                    (Math.abs(dx) > DRAG_CLICK_THRESHOLD_PX || Math.abs(dy) > DRAG_CLICK_THRESHOLD_PX)) {
                    st.moved = true;
                }
                setDragPos({
                    left: st.originLeft + dx,
                    top: st.originTop + dy,
                });
            };
            const onUp = () => {
                detachDragListeners();
                // Defer clearing `moved` to next tick so the trailing click event still
                // sees it (and skips pin-toggle).
                setTimeout(() => {
                    dragStateRef.current = null;
                }, 0);
            };
            dragListenersRef.current = { onMove, onUp };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
        const dragStyle = dragPos
            ? {
                left: `${dragPos.left}px`,
                top: `${dragPos.top}px`,
                right: 'auto',
                bottom: 'auto',
                transform: 'none',
            }
            : {};
        const className = [
            'journy-message-banner',
            dragPos ? null : `journy-message-banner-${position}`,
            isExiting ? 'journy-message-banner-exiting' : null,
            isPinned ? 'journy-message-banner-pinned' : null,
        ]
            .filter(Boolean)
            .join(' ');
        return (React__namespace.createElement("div", { ref: bannerRef, className: className, role: "status", "aria-live": "polite", style: dragStyle, onMouseEnter: handleMouseEnter, onMouseLeave: handleMouseLeave, onMouseDown: handleDragMouseDown },
            React__namespace.createElement("div", { className: "journy-message-banner-pin", "aria-label": isPinned ? 'Pinned — click banner to unpin' : 'Click banner to pin' },
                React__namespace.createElement(PinIcon, { pinned: isPinned })),
            React__namespace.createElement("div", { className: "journy-message-banner-content", onClick: handleContentClick },
                React__namespace.createElement(MessageRenderer, { message: message })),
            onDismissMessage ? (React__namespace.createElement("button", { type: "button", className: "journy-message-banner-close", onClick: (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    triggerDismiss(message.id);
                }, title: "Dismiss message", "aria-label": "Dismiss" }, "\u00D7")) : null));
    };

    const SETTINGS_STORAGE_KEY = 'widget_settings';
    /** Derives unread count from the messages array. */
    function useMessageCounts(messages) {
        return React.useMemo(() => {
            const unreadCount = messages.filter((m) => !m.received).length;
            return { unreadCount };
        }, [messages]);
    }
    const MessageWidget = ({ store, onClose, onCloseWidget, onLinkClick, onToggleExpand, onMessageReceived, onDismissMessage, onNextMessage, onPrevMessage, onSettingsChange, configInfo, initialSettings, }) => {
        const { messages, currentMessage, currentBanner, isCollapsed, displayMode, widgetVisible, } = useMessagingStore(store);
        const nonBannerMessages = React.useMemo(() => messages.filter((m) => !m.isBanner), [messages]);
        const { unreadCount } = useMessageCounts(nonBannerMessages);
        const [modalMessage, setModalMessage] = React.useState(null);
        const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
        const [settings, setSettings] = React.useState(() => {
            if (initialSettings) {
                return { ...initialSettings, displayMode };
            }
            const saved = getItem(SETTINGS_STORAGE_KEY);
            return saved
                ? { ...DEFAULT_WIDGET_SETTINGS, ...saved, displayMode }
                : { ...DEFAULT_WIDGET_SETTINGS, displayMode };
        });
        const isListMode = displayMode === 'list';
        const { position, isDragging, isResizing, widgetRef, justFinishedDragging, currentWidth, currentHeight, handleMouseDown, handleResizeStart, } = useWidgetDragResize({ isCollapsed, isListMode });
        const contentRef = React.useRef(null);
        const scrollTimerRef = React.useRef(null);
        // Persist scroll position on scroll (debounced), restore on mount/expand
        React.useEffect(() => {
            if (isCollapsed || !isListMode)
                return;
            const el = contentRef.current;
            if (!el)
                return;
            const savedScroll = getItem('widget_scroll_position');
            if (savedScroll != null) {
                el.scrollTop = savedScroll;
            }
            const handleScroll = () => {
                if (scrollTimerRef.current)
                    clearTimeout(scrollTimerRef.current);
                scrollTimerRef.current = setTimeout(() => {
                    setItem('widget_scroll_position', el.scrollTop);
                }, 150);
            };
            el.addEventListener('scroll', handleScroll, { passive: true });
            return () => {
                el.removeEventListener('scroll', handleScroll);
                if (scrollTimerRef.current)
                    clearTimeout(scrollTimerRef.current);
            };
        }, [isCollapsed, isListMode]);
        const handleSettingsChange = React.useCallback((newSettings) => {
            setSettings(newSettings);
            setItem(SETTINGS_STORAGE_KEY, newSettings);
            onSettingsChange?.(newSettings);
        }, [onSettingsChange]);
        const handleLinkClick = (e) => {
            e.preventDefault();
            onLinkClick(e.currentTarget.href);
        };
        const handleContentClick = (message, e) => {
            const target = e.target;
            if (target.tagName === 'A') {
                handleLinkClick(e);
                return;
            }
            if (onMessageReceived && !message.received) {
                onMessageReceived([message.id]);
            }
            setModalMessage(message);
        };
        const bannerOverlay = currentBanner && !widgetVisible ? (React__namespace.createElement(BannerView, { message: currentBanner, position: settings.bannerPosition, autoDismissMs: settings.bannerAutoDismissMs, onMessageReceived: onMessageReceived, onDismissMessage: onDismissMessage, onLinkClick: onLinkClick })) : null;
        const bannerSettingsHost = isDebugSettings() && !widgetVisible ? (React__namespace.createElement("div", { className: "journy-banner-settings-host" },
            React__namespace.createElement("button", { type: "button", className: "journy-banner-settings-trigger", onClick: () => setIsSettingsOpen(true), title: "Open settings", "aria-label": "Open settings" }, "\u2699"),
            React__namespace.createElement(SettingsPanel, { isOpen: isSettingsOpen, onClose: () => setIsSettingsOpen(false), settings: settings, onSettingsChange: handleSettingsChange, configInfo: configInfo }))) : null;
        if (!widgetVisible) {
            return (React__namespace.createElement(React__namespace.Fragment, null,
                bannerOverlay,
                bannerSettingsHost));
        }
        // Get messages for display: widget mode shows all messages for consistent navigation;
        // list mode prioritises unread messages when available.
        // Apply showReadMessages setting: when disabled, filter out read messages in list mode.
        const widgetSourceMessages = nonBannerMessages;
        const unreadMessages = widgetSourceMessages.filter(msg => !msg.received);
        const filteredMessages = isListMode && !settings.showReadMessages
            ? unreadMessages
            : widgetSourceMessages;
        const allMessagesToShow = isListMode
            ? (unreadMessages.length > 0 && settings.showReadMessages ? filteredMessages : (filteredMessages.length > 0 ? filteredMessages : widgetSourceMessages))
            : widgetSourceMessages;
        const displayMessage = currentMessage || (!isCollapsed && allMessagesToShow.length > 0 ? allMessagesToShow[0] : null);
        const currentMessageIndex = displayMessage
            ? Math.max(0, allMessagesToShow.findIndex((m) => m.id === displayMessage.id))
            : 0;
        const canGoPrev = !isListMode && allMessagesToShow.length > 1 && currentMessageIndex > 0;
        const canGoNext = !isListMode && allMessagesToShow.length > 1 && currentMessageIndex < allMessagesToShow.length - 1;
        return (React__namespace.createElement("div", { ref: widgetRef, className: `journy-message-widget ${!isCollapsed ? 'journy-message-widget-expanded' : 'journy-message-widget-collapsed'} ${isDragging ? 'journy-message-widget-dragging' : ''} ${isResizing ? 'journy-message-widget-resizing' : ''}`, style: {
                left: `${position.left}px`,
                top: `${position.top}px`,
                width: `${currentWidth}px`,
                height: `${currentHeight}px`,
                transition: isDragging || isResizing ? 'none' : `height ${TRANSITION_DURATION_S}s ease-out, width ${TRANSITION_DURATION_S}s ease-out, top ${TRANSITION_DURATION_S}s ease-out, left ${TRANSITION_DURATION_S}s ease-out`,
            }, onClick: (e) => {
                if (justFinishedDragging.current) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                if (!isCollapsed)
                    return;
                const target = e.target;
                if (!target.closest('button') && target.tagName !== 'A' && !target.closest('a')) {
                    onToggleExpand();
                }
            } },
            React__namespace.createElement(WidgetHeader, { isCollapsed: isCollapsed, isListMode: isListMode, unreadCount: unreadCount, displayMessage: displayMessage, allMessagesToShow: allMessagesToShow, onToggleExpand: onToggleExpand, onClose: onClose, onCloseWidget: onCloseWidget, onOpenSettings: () => setIsSettingsOpen(true), handleMouseDown: handleMouseDown }),
            !isCollapsed && isListMode && (React__namespace.createElement(WidgetListView, { messages: allMessagesToShow, contentRef: contentRef, isEmpty: allMessagesToShow.length === 0, onMessageReceived: onMessageReceived, onDismissMessage: onDismissMessage, onContentClick: handleContentClick, handleResizeStart: handleResizeStart })),
            !isCollapsed && !isListMode && allMessagesToShow.length > 0 && (React__namespace.createElement(WidgetSingleView, { displayMessage: displayMessage, allMessagesToShow: allMessagesToShow, currentMessageIndex: currentMessageIndex, canGoPrev: canGoPrev, canGoNext: canGoNext, onMessageReceived: onMessageReceived, onDismissMessage: onDismissMessage, onContentClick: handleContentClick, onPrevMessage: onPrevMessage, onNextMessage: onNextMessage })),
            isDebugSettings() && !isCollapsed && (React__namespace.createElement(SettingsPanel, { isOpen: isSettingsOpen, onClose: () => setIsSettingsOpen(false), settings: settings, onSettingsChange: handleSettingsChange, configInfo: configInfo })),
            modalMessage && (React__namespace.createElement(MessagePopup, { message: modalMessage, onClose: () => setModalMessage(null), onLinkClick: onLinkClick }))));
    };

    var MessageWidgetModule = /*#__PURE__*/Object.freeze({
        __proto__: null,
        MessageWidget: MessageWidget,
        default: MessageWidget
    });

    class UIRenderer {
        constructor(renderCtx) {
            this.renderCtx = renderCtx;
            this.reactRoot = null;
            this.reactRootContainer = null;
        }
        initialize(rootElement, props) {
            if (typeof window !== 'undefined' && window.React && window.ReactDOM) {
                this.render(rootElement, props);
            }
            else {
                this.waitForReact(rootElement, props);
            }
        }
        waitForReact(rootElement, props) {
            const checkInterval = setInterval(() => {
                if (typeof window !== 'undefined' && window.React && window.ReactDOM) {
                    clearInterval(checkInterval);
                    this.render(rootElement, props);
                }
            }, REACT_CHECK_INTERVAL);
            setTimeout(() => {
                clearInterval(checkInterval);
            }, REACT_WAIT_TIMEOUT);
        }
        render(rootElement, props) {
            try {
                const React = window.React;
                const ReactDOM = window.ReactDOM;
                if (!React || !ReactDOM) {
                    throw new Error('React or ReactDOM not found in window');
                }
                // If the container was replaced (e.g. root removed and re-created), create a new React root
                if (this.reactRoot && this.reactRootContainer !== rootElement) {
                    this.reactRoot = null;
                    this.reactRootContainer = null;
                }
                const MessageWidget$1 = MessageWidget || MessageWidget;
                if (!MessageWidget$1) {
                    console.error('MessageWidget not found in module:', MessageWidgetModule);
                    throw new Error('MessageWidget not found in module');
                }
                const widgetElement = React.createElement(MessageWidget$1, props);
                const element = React.createElement(RenderCtx.Provider, { value: this.renderCtx }, widgetElement);
                // Use React 18 createRoot if available, otherwise fall back to render
                if (ReactDOM.createRoot) {
                    if (!this.reactRoot) {
                        rootElement.innerHTML = '';
                        this.reactRoot = ReactDOM.createRoot(rootElement);
                        this.reactRootContainer = rootElement;
                    }
                    this.reactRoot.render(element);
                }
                else {
                    rootElement.innerHTML = '';
                    ReactDOM.render(element, rootElement);
                }
            }
            catch (error) {
                console.error('Failed to render UI:', error);
            }
        }
        unmount() {
            if (this.reactRoot) {
                try {
                    this.reactRoot.unmount();
                }
                catch (error) {
                    console.error('Error unmounting React root:', error);
                }
                this.reactRoot = null;
                this.reactRootContainer = null;
            }
        }
    }

    /**
     * One live instance per identity. React StrictMode double-mounts, and hosts do
     * construct without destroying the previous instance — either way the old copy
     * keeps its own poller running, doubling the request rate against a budget that
     * is already shared across every tab on the write key.
     */
    const liveInstances = new Map();
    function getInstanceKey(config) {
        const entityId = config.entityType === 'user' ? config.userId : config.accountId;
        return `${config.writeKey}:${config.entityType}:${entityId ?? ''}`;
    }
    class JournyMessaging {
        constructor(config) {
            this.initialized = false;
            this.uiInitialized = false;
            this.pollTimer = null;
            this.rootElementId = ROOT_ELEMENT_ID;
            this.unsubscribePersistence = null;
            this.beforeUnloadHandler = null;
            this.consecutiveFailures = 0;
            this.retryAfterMs = null;
            this.destroyed = false;
            this.visibilityHandler = null;
            this.config = {
                apiEndpoint: DEFAULT_API_ENDPOINT,
                pollingInterval: DEFAULT_POLLING_INTERVAL,
                hideUntilMessages: true,
                ...config,
            };
            if (!this.config.writeKey) {
                throw new Error('writeKey is required');
            }
            if (!this.config.entityType) {
                throw new Error('entityType is required');
            }
            this.instanceKey = getInstanceKey(this.config);
            // Last one wins: superseding the previous instance is safe because this one is
            // about to render the same widget, whereas leaving it alive means two pollers.
            liveInstances.get(this.instanceKey)?.destroy();
            liveInstances.set(this.instanceKey, this);
            this.renderCtx = resolveRenderContext(config.renderTarget);
            // Clean up parent DOM when iframe unloads
            if (this.renderCtx.isRemote) {
                this.beforeUnloadHandler = () => this.destroy();
                window.addEventListener('beforeunload', this.beforeUnloadHandler);
            }
            this.apiClient = new ApiClient(this.config);
            this.messageQueue = new MessageQueue();
            this.analyticsClient = new AnalyticsClient(this.config);
            this.eventTracker = new EventTracker(this.analyticsClient);
            this.uiRenderer = new UIRenderer(this.renderCtx);
            this.receiptQueue = new ReceiptQueue({
                send: (messageIds) => this.apiClient.markAsRead(messageIds),
                onDropped: (messageIds, error) => {
                    // The optimistic UI mark cannot be trusted now — the server still has these
                    // unread, so they will reappear on reload. Say so rather than let it look fine.
                    this.messageQueue.markMessagesAsUnreceived(messageIds);
                    this.store.setState({ messages: this.messageQueue.getAllMessages() });
                    this.handleError(error);
                },
            });
            // Build default settings from config, then overlay any saved settings.
            // Explicit config values (provided by the host) always take precedence over
            // saved localStorage settings so that changing config.js is never silently
            // ignored.
            const configOverrides = {
                ...(config.pollingInterval != null && { pollingInterval: config.pollingInterval }),
                ...(config.apiEndpoint != null && { apiEndpoint: config.apiEndpoint }),
                ...(config.styles != null && { styles: config.styles }),
                ...(config.bannerPosition != null && { bannerPosition: config.bannerPosition }),
                ...(config.bannerAutoDismissMs != null && { bannerAutoDismissMs: config.bannerAutoDismissMs }),
                ...(config.displayMode != null && { displayMode: config.displayMode }),
            };
            const savedSettings = getItem(STORAGE_KEYS.WIDGET_SETTINGS);
            this.widgetSettings = {
                ...DEFAULT_WIDGET_SETTINGS,
                ...(savedSettings || {}),
                ...configOverrides,
            };
            // Apply settings back to config so they take effect
            this.config.pollingInterval = this.widgetSettings.pollingInterval;
            this.config.apiEndpoint = this.widgetSettings.apiEndpoint;
            const savedVisible = getItem(STORAGE_KEYS.WIDGET_VISIBLE);
            const savedCollapsed = getItem(STORAGE_KEYS.WIDGET_COLLAPSED);
            this.store = new MessagingStore({
                messages: [],
                currentMessage: null,
                currentBanner: null,
                isCollapsed: savedCollapsed ?? this.config.isCollapsed ?? true,
                widgetVisible: savedVisible ?? true,
                displayMode: this.widgetSettings.displayMode,
            });
            this.unsubscribePersistence = this.store.subscribe(() => {
                const state = this.store.getState();
                setItem(STORAGE_KEYS.WIDGET_VISIBLE, state.widgetVisible);
                setItem(STORAGE_KEYS.WIDGET_COLLAPSED, state.isCollapsed);
                if (state.currentMessage) {
                    setItem(STORAGE_KEYS.CURRENT_MESSAGE_ID, state.currentMessage.id);
                }
                else {
                    removeItem(STORAGE_KEYS.CURRENT_MESSAGE_ID);
                }
            });
            this.init();
        }
        get uiState() {
            return this.store.getState();
        }
        async init() {
            if (this.initialized)
                return;
            // Set before the first await: React StrictMode double-mounts, and two instances
            // racing through here would each start their own poller.
            this.initialized = true;
            if (!this.shouldHideUntilMessages()) {
                this.ensureUIInitialized();
            }
            await this.loadMessages();
            if (isDebugMockMessages() && this.messageQueue.getActiveCount() === 0) {
                this.injectDebugMessages();
            }
            this.listenForVisibility();
            this.scheduleNextPoll();
            if (this.messageQueue.getActiveCount() > 0) {
                this.ensureUIInitialized();
            }
        }
        shouldHideUntilMessages() {
            return this.config.hideUntilMessages !== false;
        }
        ensureUIInitialized() {
            if (this.uiInitialized)
                return;
            this.initializeUI();
            this.uiInitialized = true;
        }
        injectDebugMessages() {
            const mockMessages = createDebugMessages(this.config.entityType);
            this.messageQueue.addMessages(mockMessages);
            this.store.setState({
                messages: this.messageQueue.getAllMessages(),
                widgetVisible: true,
                isCollapsed: false,
            });
            this.displayNextMessage();
        }
        async loadMessages() {
            try {
                const result = await this.apiClient.getUnreadMessages();
                if (!result.ok) {
                    // Deliberately not treated as "no messages": leaving the queue untouched
                    // keeps whatever is already on screen instead of blanking the widget.
                    this.consecutiveFailures++;
                    this.retryAfterMs =
                        result.error.kind === 'rate-limited' &&
                            result.error.retryAfterSeconds !== undefined
                            ? result.error.retryAfterSeconds * 1000
                            : null;
                    this.handleError(result.error);
                    return;
                }
                this.consecutiveFailures = 0;
                this.retryAfterMs = null;
                const messages = result.data;
                const previousNonBannerCount = this.messageQueue.getUnreadNonBannerCount();
                this.messageQueue.addMessages(messages);
                const newNonBannerCount = this.messageQueue.getUnreadNonBannerCount();
                const newNonBannerArrived = newNonBannerCount > previousNonBannerCount;
                let updates = {
                    messages: this.messageQueue.getAllMessages(),
                };
                if (newNonBannerArrived) {
                    updates.widgetVisible = true;
                    if (this.widgetSettings.autoExpandOnNew) {
                        updates.isCollapsed = false;
                    }
                    // A new non-banner takes priority: hide any visible banner without
                    // marking it read so it returns to the queue.
                    if (this.uiState.currentBanner) {
                        updates.currentBanner = null;
                    }
                }
                this.store.setState(updates);
                if (this.messageQueue.getActiveCount() > 0) {
                    this.ensureUIInitialized();
                }
                if (!this.uiState.currentMessage && newNonBannerCount > 0) {
                    const savedMessageId = getItem(STORAGE_KEYS.CURRENT_MESSAGE_ID);
                    const allMessages = this.messageQueue.getNonBannerMessages();
                    const savedMessage = savedMessageId ? allMessages.find(m => m.id === savedMessageId) : null;
                    if (savedMessage) {
                        this.store.setState({ currentMessage: savedMessage });
                    }
                    else {
                        this.displayNextMessage();
                    }
                }
                // Auto-mark current message as received when widget is expanded
                if (!this.uiState.isCollapsed && this.uiState.currentMessage && !this.uiState.currentMessage.received) {
                    this.handleMessageReceived([this.uiState.currentMessage.id]);
                }
                this.maybeShowBanner();
            }
            catch (error) {
                console.error('Failed to load messages:', error);
            }
        }
        /**
         * Banners surface whenever the widget is closed. Unread non-banner messages
         * don't block a banner — the user has dismissed the widget, so the banner is
         * the only remaining surface for new notifications. They sit in their own
         * slot on the store; pin / dismiss / drag state lives in the BannerView
         * component.
         */
        maybeShowBanner() {
            if (this.uiState.currentBanner)
                return;
            if (this.uiState.widgetVisible)
                return;
            const nextBanner = this.messageQueue.getNextBanner();
            if (!nextBanner)
                return;
            this.store.setState({ currentBanner: nextBanner });
            this.ensureUIInitialized();
        }
        getBaseInterval() {
            return this.config.pollingInterval || DEFAULT_POLLING_INTERVAL;
        }
        /**
         * Backs off while the server is rejecting us, and spreads every poll out so a
         * wave of tabs opened at the same moment (a deploy, a morning login rush) does
         * not arrive on the same second.
         */
        getNextPollDelay() {
            const base = this.getBaseInterval();
            const backoff = Math.min(base * Math.pow(BACKOFF_MULTIPLIER, this.consecutiveFailures), MAX_BACKOFF_INTERVAL);
            // Never poll sooner than a 429's Retry-After asked, even when plain backoff
            // would fire earlier.
            const wait = Math.max(backoff, this.retryAfterMs ?? 0);
            const jitter = wait * POLLING_JITTER_RATIO * Math.random();
            return wait + jitter;
        }
        /**
         * Self-scheduling rather than setInterval: a fixed-rate timer keeps firing while
         * a request is still in flight, so a slow or rate-limited server just gets more
         * traffic. Each poll now schedules the next one only once it has finished.
         */
        scheduleNextPoll(delay = this.getNextPollDelay()) {
            this.clearPollTimer();
            if (this.destroyed)
                return;
            this.pollTimer = setTimeout(async () => {
                this.pollTimer = null;
                if (this.isDocumentHidden()) {
                    // A background tab has nobody to show a message to; wait rather than spend
                    // a slot from the budget shared with every other tab on this write key.
                    this.scheduleNextPoll();
                    return;
                }
                await this.loadMessages();
                this.scheduleNextPoll();
            }, delay);
        }
        isDocumentHidden() {
            return this.renderCtx.targetDocument?.visibilityState === 'hidden';
        }
        clearPollTimer() {
            if (this.pollTimer !== null) {
                clearTimeout(this.pollTimer);
                this.pollTimer = null;
            }
        }
        /** Polls straight away when the tab comes back, so a returning user isn't stale. */
        listenForVisibility() {
            const doc = this.renderCtx.targetDocument;
            if (!doc?.addEventListener)
                return;
            this.visibilityHandler = () => {
                if (doc.visibilityState === 'visible' && !this.destroyed) {
                    this.scheduleNextPoll(0);
                }
            };
            doc.addEventListener('visibilitychange', this.visibilityHandler);
        }
        handleError(error) {
            this.config.onError?.(error);
            console.error('Journy messaging request failed:', error.message);
        }
        applyStyles(stylesConfig) {
            const doc = this.renderCtx.targetDocument;
            removeInjectedStyles(doc);
            if (stylesConfig === 'none') {
                // Host provides all styles; do not inject anything
                return;
            }
            // Always inject the default styles first so a custom `css`/`url` layers on
            // top of them (later rules win the cascade) instead of replacing them.
            injectStyleTag(defaultStyles, DEFAULT_STYLE_ID, doc);
            if (stylesConfig && stylesConfig !== 'default') {
                if ('url' in stylesConfig && stylesConfig.url) {
                    injectStyleLink(stylesConfig.url, doc);
                }
                else if ('css' in stylesConfig && stylesConfig.css) {
                    injectStyleTag(stylesConfig.css, undefined, doc);
                }
            }
        }
        initializeUI() {
            const rootElement = createRootElement(this.rootElementId, this.renderCtx.targetDocument);
            this.applyStyles(this.widgetSettings.styles);
            this.uiRenderer.initialize(rootElement, this.buildWidgetProps());
        }
        buildWidgetProps() {
            return {
                store: this.store,
                onClose: () => this.handleMessageClose(),
                onCloseWidget: () => this.handleCloseWidget(),
                onLinkClick: (url) => this.handleLinkClick(url),
                onToggleExpand: () => this.handleToggleExpand(),
                onMessageReceived: (messageIds) => this.handleMessageReceived(messageIds),
                onDismissMessage: (messageId) => this.handleDismissMessage(messageId),
                onNextMessage: () => this.handleNextMessage(),
                onPrevMessage: () => this.handlePrevMessage(),
                onSettingsChange: (settings) => this.handleSettingsChange(settings),
                configInfo: {
                    entityType: this.config.entityType,
                    userId: this.config.userId,
                    accountId: this.config.accountId,
                },
                initialSettings: this.widgetSettings,
            };
        }
        handleSettingsChange(newSettings) {
            const prev = this.widgetSettings;
            this.widgetSettings = newSettings;
            setItem(STORAGE_KEYS.WIDGET_SETTINGS, newSettings);
            this.config.pollingInterval = newSettings.pollingInterval;
            this.config.apiEndpoint = newSettings.apiEndpoint;
            if (newSettings.pollingInterval !== prev.pollingInterval) {
                // Re-arm on the new interval rather than waiting out the old one.
                this.scheduleNextPoll();
            }
            if (newSettings.displayMode !== prev.displayMode) {
                this.store.setState({ displayMode: newSettings.displayMode });
            }
            if (JSON.stringify(newSettings.styles) !== JSON.stringify(prev.styles)) {
                this.applyStyles(newSettings.styles);
            }
            if (newSettings.apiEndpoint !== prev.apiEndpoint) {
                this.apiClient = new ApiClient(this.config);
            }
        }
        handleToggleExpand() {
            this.store.setState({ isCollapsed: !this.uiState.isCollapsed });
        }
        displayNextMessage() {
            const nextMessage = this.messageQueue.getNextMessage();
            if (nextMessage && nextMessage.id !== this.uiState.currentMessage?.id) {
                this.showMessage(nextMessage);
                return;
            }
            this.store.setState({
                currentMessage: nextMessage || null,
                messages: this.messageQueue.getAllMessages(),
            });
        }
        showMessage(message) {
            this.store.setState({
                currentMessage: message,
                messages: this.messageQueue.getAllMessages(),
            });
            this.eventTracker.track(SDKEventType.MessageOpened, {
                messageId: message.id,
            });
        }
        handleMessageClose() {
            const { currentMessage } = this.uiState;
            if (currentMessage) {
                this.eventTracker.track(SDKEventType.MessageClosed, {
                    messageId: currentMessage.id,
                });
                this.markAsRead([currentMessage.id]);
                this.store.setState({ currentMessage: null, isCollapsed: false });
                setTimeout(() => {
                    this.displayNextMessage();
                    this.maybeShowBanner();
                }, MESSAGE_CLOSE_DELAY);
            }
        }
        handleCloseWidget() {
            this.store.setState({ widgetVisible: false });
            this.maybeShowBanner();
        }
        async handleDismissMessage(messageId) {
            this.eventTracker.track(SDKEventType.MessageClosed, { messageId });
            const wasBanner = this.uiState.currentBanner?.id === messageId;
            await this.markAsRead([messageId]);
            if (this.uiState.currentMessage?.id === messageId) {
                this.store.setState({ currentMessage: null });
                this.displayNextMessage();
            }
            if (wasBanner) {
                this.store.setState({ currentBanner: null });
                // Once the banner finishes (auto-dismiss timer or user close), unread
                // non-banner messages take precedence over the next banner — re-surface
                // the widget instead of cycling to another banner.
                if (this.messageQueue.getUnreadNonBannerCount() > 0) {
                    this.reopenWidgetForUnread();
                }
                else {
                    this.maybeShowBanner();
                }
            }
        }
        reopenWidgetForUnread() {
            const updates = { widgetVisible: true };
            if (this.widgetSettings.autoExpandOnNew) {
                updates.isCollapsed = false;
            }
            this.store.setState(updates);
            this.ensureUIInitialized();
            if (!this.uiState.currentMessage) {
                this.displayNextMessage();
            }
        }
        navigateMessage(direction) {
            const list = this.messageQueue.getAllMessages();
            const idx = list.findIndex((m) => m.id === this.uiState.currentMessage?.id);
            const targetIdx = idx + direction;
            if (targetIdx < 0 || targetIdx >= list.length)
                return;
            const targetMessage = list[targetIdx];
            if (!targetMessage.received) {
                this.store.setState({ currentMessage: targetMessage });
                this.handleMessageReceived([targetMessage.id]);
            }
            else {
                this.store.setState({ currentMessage: targetMessage });
            }
        }
        handleNextMessage() {
            this.navigateMessage(1);
        }
        handlePrevMessage() {
            this.navigateMessage(-1);
        }
        handleLinkClick(url) {
            const { currentMessage } = this.uiState;
            if (currentMessage) {
                this.eventTracker.track(SDKEventType.MessageLinkClicked, {
                    messageId: currentMessage.id,
                    linkUrl: url,
                });
            }
        }
        async markAsRead(messageIds) {
            const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
            await this.handleMessageReceived(ids);
            this.messageQueue.removeMessage(ids);
            this.store.setState({ messages: this.messageQueue.getAllMessages() });
        }
        async handleMessageReceived(messageIds) {
            const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
            const alreadyReceivedIds = this.messageQueue.getAlreadyReceivedIds(ids);
            if (alreadyReceivedIds.length === ids.length)
                return;
            // Track locally first to prevent duplicate sends
            this.messageQueue.markMessageAsReceived(ids);
            const { currentMessage } = this.uiState;
            const updates = {
                messages: this.messageQueue.getAllMessages(),
            };
            if (currentMessage && ids.includes(currentMessage.id)) {
                updates.currentMessage = { ...currentMessage, received: true };
            }
            this.store.setState(updates);
            // Queued rather than sent: the UI mark above is optimistic, but delivery is only
            // done once the server confirms. The queue batches ids into one call and keeps
            // retrying, so a receipt lost to a 429 no longer leaves the message unread
            // server-side for good.
            this.receiptQueue.add(ids);
            await this.analyticsClient.sendAnalyticsEvents(ids);
        }
        /** Track a link click event for analytics. Called by host apps when a user clicks a link inside a message. */
        trackLinkClick(messageId, linkUrl) {
            this.eventTracker.track(SDKEventType.MessageLinkClicked, {
                messageId,
                linkUrl,
            });
        }
        /** Track a message closed event. Called by host apps when a user dismisses a message. */
        trackMessageClosed(messageId) {
            this.eventTracker.track(SDKEventType.MessageClosed, {
                messageId,
            });
        }
        /** Track a message opened event. Called by host apps when a user views a message. */
        trackMessageOpened(messageId) {
            this.eventTracker.track(SDKEventType.MessageOpened, {
                messageId,
            });
        }
        destroy() {
            this.destroyed = true;
            this.clearPollTimer();
            // Last chance to deliver what the user already read; anything still unsent is
            // retried by whichever instance replaces this one, after the server returns it.
            void this.receiptQueue.flush();
            this.receiptQueue.destroy();
            if (this.visibilityHandler) {
                this.renderCtx.targetDocument?.removeEventListener?.('visibilitychange', this.visibilityHandler);
                this.visibilityHandler = null;
            }
            if (liveInstances.get(this.instanceKey) === this) {
                liveInstances.delete(this.instanceKey);
            }
            if (this.unsubscribePersistence) {
                this.unsubscribePersistence();
                this.unsubscribePersistence = null;
            }
            this.eventTracker.destroy();
            this.store.destroy();
            this.uiRenderer.unmount();
            this.uiInitialized = false;
            if (this.beforeUnloadHandler) {
                window.removeEventListener('beforeunload', this.beforeUnloadHandler);
                this.beforeUnloadHandler = null;
            }
            removeRootElement(this.rootElementId, this.renderCtx.targetDocument);
            removeInjectedStyles(this.renderCtx.targetDocument);
        }
    }

    // For UMD/global usage
    if (typeof window !== 'undefined') {
        window.JournyMessages = JournyMessaging;
    }

    exports.JournyMessaging = JournyMessaging;
    exports.default = JournyMessaging;

    Object.defineProperty(exports, '__esModule', { value: true });

}));
//# sourceMappingURL=journy-messages.js.map
