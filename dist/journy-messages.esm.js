import * as React from 'react';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

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
        if (this.queue.length === 0) {
            return null;
        }
        return this.queue[0];
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
        const updateReceived = (m) => messageIds.includes(m.id) ? { ...m, received: true } : m;
        this.queue = this.queue.map(updateReceived);
        this.allFetchedMessages = this.allFetchedMessages.map(updateReceived);
        // Keep messageMap in sync so subsequent addMessages calls see received=true
        for (const id of messageIds) {
            if (this.messageMap[id]) {
                this.messageMap[id] = { ...this.messageMap[id], received: true };
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
        const unreadMessages = this.queue.filter((m) => !m.received);
        const readMessages = this.queue.filter((m) => m.received);
        this.queue = [...unreadMessages.sort(this.sortByCreatedAt), ...readMessages.sort(this.sortByCreatedAt)];
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
        const updated = { ...queueMessage, received: message.received, expired: message.expired, status: message.status };
        const idx = this.queue.indexOf(queueMessage);
        if (idx !== -1)
            this.queue[idx] = updated;
        const fetchedIdx = this.allFetchedMessages.indexOf(queueMessage);
        if (fetchedIdx !== -1)
            this.allFetchedMessages[fetchedIdx] = updated;
        this.messageMap[updated.id] = updated;
    }
}

const API_PATHS = {
    IN_APP_MESSAGES: '/sdk/in-app-messages',
};
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
        const baseUrl = (this.config.apiEndpoint || 'https://jtm.journy.io').replace(/\/$/, '');
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
        try {
            const url = this.buildUrl('/unread');
            const response = await fetch(url, {
                method: 'GET',
                headers: this.getHeaders(),
                mode: 'cors', // Explicitly set CORS mode
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            return data.data || [];
        }
        catch (error) {
            console.error('Failed to fetch unread messages:', error);
            return [];
        }
    }
    async markAsRead(messageIds) {
        try {
            const url = this.buildUrl('/received');
            const response = await fetch(url, {
                method: 'POST',
                headers: this.getHeaders(),
                mode: 'cors',
                body: JSON.stringify({
                    messageIds: messageIds,
                }),
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            if (data.data && data.data.markedCount !== messageIds.length) {
                throw new Error(`Failed to mark all messages as read. Expected ${messageIds.length} messages, got ${data.data.markedCount}`);
            }
        }
        catch (error) {
            console.error('Failed to mark message as read:', error);
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
const DEFAULT_WIDGET_SETTINGS = {
    pollingInterval: 30000,
    showReadMessages: true,
    autoExpandOnNew: true,
    displayMode: 'widget',
    apiEndpoint: 'https://jtm.journy.io',
    styles: 'default',
};

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

function createRootElement(id) {
    let element = document.getElementById(id);
    if (!element) {
        element = document.createElement('div');
        element.id = id;
        document.body.appendChild(element);
    }
    return element;
}
function removeRootElement(id) {
    const element = document.getElementById(id);
    if (element) {
        element.remove();
    }
}
const STYLES_LINK_ID = 'journy-messages-styles-link';
const STYLES_TAG_ID = 'journy-messages-custom';
const DEFAULT_STYLES_TAG_ID = 'journy-messages-default';
function injectStyleLink(href) {
    if (typeof document === 'undefined' || !document.head)
        return;
    const existing = document.getElementById(STYLES_LINK_ID);
    if (existing && existing instanceof HTMLLinkElement && existing.href === href)
        return;
    if (existing)
        existing.remove();
    const link = document.createElement('link');
    link.id = STYLES_LINK_ID;
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
}
function injectStyleTag(css, id = STYLES_TAG_ID) {
    if (typeof document === 'undefined' || !document.head)
        return;
    let style = document.getElementById(id);
    if (style) {
        style.textContent = css;
        return;
    }
    style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
}
function removeInjectedStyles() {
    if (typeof document === 'undefined')
        return;
    const link = document.getElementById(STYLES_LINK_ID);
    if (link)
        link.remove();
    const style = document.getElementById(STYLES_TAG_ID);
    if (style)
        style.remove();
    const defaultStyle = document.getElementById(DEFAULT_STYLES_TAG_ID);
    if (defaultStyle)
        defaultStyle.remove();
}

var defaultStyles = "/* Widget Container */\n.journy-message-widget {\n  position: fixed;\n  z-index: 10000;\n  background: white;\n  border-radius: 12px;\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);\n  overflow: hidden;\n  user-select: none;\n  transform-origin: bottom right;\n}\n\n.journy-message-widget.journy-message-widget-dragging {\n  cursor: grabbing;\n  transition: none;\n  z-index: 10001;\n}\n\n.journy-message-widget.journy-message-widget-expanded {\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n}\n\n.journy-message-widget.journy-message-widget-resizing {\n  transition: none;\n}\n\n/* Expand/collapse: height and top are animated via inline transition so bottom-right stays fixed */\n\n/* Widget Header */\n.journy-message-widget-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 12px 16px;\n  background: #f9fafb;\n  border-bottom: 1px solid #e5e7eb;\n  user-select: none;\n}\n\n.journy-message-widget-drag-handle {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  padding: 4px 8px;\n  margin-right: 8px;\n  cursor: grab;\n  color: #9ca3af;\n  transition: color 0.2s;\n  flex-shrink: 0;\n}\n\n.journy-message-widget-drag-handle:active {\n  cursor: grabbing;\n  color: #6b7280;\n}\n\n.journy-message-widget-drag-handle:hover {\n  color: #6b7280;\n}\n\n.journy-message-widget-drag-handle svg {\n  display: block;\n}\n\n.journy-message-widget-header-content {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex: 1;\n  flex-wrap: wrap;\n  cursor: pointer;\n}\n\n.journy-message-widget-badge {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  min-width: 24px;\n  height: 24px;\n  padding: 0 8px;\n  background: #3b82f6;\n  color: white;\n  border-radius: 12px;\n  font-size: 12px;\n  font-weight: 600;\n}\n\n.journy-message-widget-title {\n  font-size: 14px;\n  font-weight: 600;\n  color: #111827;\n}\n\n.journy-message-widget-read-count {\n  font-size: 12px;\n  color: #6b7280;\n  font-weight: 400;\n}\n\n.journy-message-widget-controls {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.journy-message-widget-toggle,\n.journy-message-widget-close {\n  background: none;\n  border: none;\n  font-size: 18px;\n  line-height: 1;\n  cursor: pointer;\n  color: #6b7280;\n  padding: 4px 8px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n}\n\n.journy-message-widget-toggle:hover,\n.journy-message-widget-close:hover {\n  background-color: #e5e7eb;\n  color: #374151;\n}\n\n/* Widget Content */\n.journy-message-widget-content {\n  padding: 16px;\n  flex: 1;\n  overflow-y: auto;\n  overflow-x: hidden;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n}\n\n.journy-message-widget-content--single .journy-message-widget-message {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n}\n\n.journy-message-widget-content--single .journy-message-widget-message .journy-message-content {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n}\n\n/* Resize Handle */\n.journy-message-widget-resize-handle {\n  position: absolute;\n  bottom: 0;\n  right: 0;\n  width: 20px;\n  height: 20px;\n  cursor: nwse-resize;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: linear-gradient(135deg, transparent 0%, transparent 40%, #e5e7eb 40%, #e5e7eb 100%);\n  z-index: 10;\n  transition: background 0.2s;\n}\n\n.journy-message-widget-resize-handle:hover {\n  background: linear-gradient(135deg, transparent 0%, transparent 40%, #d1d5db 40%, #d1d5db 100%);\n}\n\n.journy-message-widget-resize-handle svg {\n  width: 12px;\n  height: 12px;\n  opacity: 0.6;\n}\n\n.journy-message-widget-resize-handle:hover svg {\n  opacity: 1;\n}\n\n.journy-message-widget-message {\n  padding: 0;\n  position: relative;\n  min-height: 60px;\n}\n\n.journy-message-widget-message-close {\n  position: absolute;\n  top: 4px;\n  right: 4px;\n  width: 24px;\n  height: 24px;\n  padding: 0;\n  border: none;\n  background: transparent;\n  color: #6b7280;\n  font-size: 18px;\n  line-height: 1;\n  cursor: pointer;\n  border-radius: 4px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  transition: background-color 0.2s, color 0.2s;\n  z-index: 1;\n}\n\n.journy-message-widget-message-close:hover {\n  background-color: #e5e7eb;\n  color: #374151;\n}\n\n.journy-message-widget-message:has(.journy-message-widget-message-close) .journy-message-content {\n  padding-right: 28px;\n}\n\n.journy-message-widget-nav {\n  background: none;\n  border: none;\n  font-size: 18px;\n  line-height: 1;\n  cursor: pointer;\n  color: #6b7280;\n  padding: 4px 6px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n}\n\n.journy-message-widget-nav:hover:not(:disabled) {\n  background-color: #e5e7eb;\n  color: #374151;\n}\n\n.journy-message-widget-nav:disabled {\n  opacity: 0.4;\n  cursor: default;\n}\n\n.journy-message-widget-message-separated {\n  margin-bottom: 24px;\n  padding-bottom: 24px;\n  border-bottom: 1px solid #e5e7eb;\n}\n\n.journy-message-widget-message-count {\n  font-size: 12px;\n  color: #6b7280;\n  font-weight: 400;\n  margin-left: 8px;\n}\n\n.journy-message-widget-position {\n  padding: 4px 12px;\n  font-size: 11px;\n  color: #9ca3af;\n  font-weight: 500;\n  text-align: right;\n  flex-shrink: 0;\n}\n\n.journy-message-widget-message.journy-message-info {\n  border-left: 4px solid #3b82f6;\n  padding-left: 12px;\n}\n\n.journy-message-widget-message.journy-message-success {\n  border-left: 4px solid #10b981;\n  padding-left: 12px;\n}\n\n.journy-message-widget-message.journy-message-warning {\n  border-left: 4px solid #f59e0b;\n  padding-left: 12px;\n}\n\n.journy-message-widget-message.journy-message-error {\n  border-left: 4px solid #ef4444;\n  padding-left: 12px;\n}\n\n.journy-message-widget-message.journy-message-viewed {\n  border-left: 4px solid #6b7280;\n  padding-left: 12px;\n}\n\n/* Message modal (80vw x 60vh) */\n.journy-message-modal-overlay {\n  position: fixed;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  background-color: rgba(0, 0, 0, 0.5);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  z-index: 10002;\n  padding: 20px;\n}\n\n.journy-message-modal {\n  width: 80vw;\n  max-width: 80vw;\n  height: 60vh;\n  max-height: 60vh;\n  background: white;\n  border-radius: 12px;\n  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);\n  overflow: hidden;\n  display: flex;\n  flex-direction: column;\n  position: relative;\n}\n\n.journy-message-modal-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 16px 24px;\n  background: #f9fafb;\n  border-bottom: 1px solid #e5e7eb;\n  flex-shrink: 0;\n}\n\n.journy-message-modal-title {\n  font-size: 18px;\n  font-weight: 600;\n  color: #111827;\n}\n\n.journy-message-modal-close {\n  background: none;\n  border: none;\n  font-size: 24px;\n  line-height: 1;\n  cursor: pointer;\n  color: #6b7280;\n  padding: 4px 8px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n}\n\n.journy-message-modal-close:hover {\n  background-color: #e5e7eb;\n  color: #374151;\n}\n\n.journy-message-modal .journy-message-widget-message {\n  padding: 24px 24px 24px 24px;\n  overflow-y: auto;\n  flex: 1;\n  min-height: 0;\n}\n\n/* Timestamp */\n.journy-message-timestamp {\n  font-size: 12px;\n  color: #6b7280;\n  margin-top: 4px;\n  line-height: 1.4;\n}\n\n.journy-message-content-clickable {\n  cursor: pointer;\n}\n\n.journy-message-content-clickable:hover {\n  opacity: 0.95;\n}\n\n/* Legacy Modal Overlay Styles (kept for backward compatibility) */\n.journy-message-overlay {\n  position: fixed;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  background-color: rgba(0, 0, 0, 0.5);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  z-index: 10000;\n  opacity: 0;\n  transition: opacity 0.3s ease-in-out;\n  pointer-events: none;\n}\n\n.journy-message-overlay.journy-message-visible {\n  opacity: 1;\n  pointer-events: all;\n}\n\n.journy-message-popup {\n  background: white;\n  border-radius: 8px;\n  padding: 24px;\n  max-width: 500px;\n  width: 90%;\n  max-height: 80vh;\n  overflow-y: auto;\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);\n  position: relative;\n  transform: scale(0.9);\n  transition: transform 0.3s ease-in-out;\n}\n\n.journy-message-overlay.journy-message-visible .journy-message-popup {\n  transform: scale(1);\n}\n\n.journy-message-popup.journy-message-info {\n  border-top: 4px solid #3b82f6;\n}\n\n.journy-message-popup.journy-message-success {\n  border-top: 4px solid #10b981;\n}\n\n.journy-message-popup.journy-message-warning {\n  border-top: 4px solid #f59e0b;\n}\n\n.journy-message-popup.journy-message-error {\n  border-top: 4px solid #ef4444;\n}\n\n.journy-message-popup.journy-message-viewed {\n  border-top: 4px solid #6b7280;\n}\n\n.journy-message-close {\n  position: absolute;\n  top: 12px;\n  right: 12px;\n  background: none;\n  border: none;\n  font-size: 24px;\n  line-height: 1;\n  cursor: pointer;\n  color: #6b7280;\n  padding: 4px 8px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n}\n\n.journy-message-close:hover {\n  background-color: #f3f4f6;\n  color: #374151;\n}\n\n.journy-message-title {\n  font-size: 20px;\n  font-weight: 600;\n  margin-bottom: 12px;\n  color: #111827;\n}\n\n.journy-message-content {\n  font-size: 16px;\n  line-height: 1.6;\n  color: #374151;\n  margin-bottom: 16px;\n}\n\n.journy-message-content a {\n  color: #3b82f6;\n  text-decoration: underline;\n  transition: color 0.2s;\n}\n\n.journy-message-content a:hover {\n  color: #2563eb;\n}\n\n.journy-message-content p {\n  margin: 0 0 12px 0;\n}\n\n.journy-message-content p:last-child {\n  margin-bottom: 0;\n}\n\n.journy-message-content ul,\n.journy-message-content ol {\n  margin: 12px 0;\n  padding-left: 24px;\n}\n\n.journy-message-content li {\n  margin-bottom: 8px;\n}\n\n/* Headings */\n.journy-message-content h1,\n.journy-message-content h2,\n.journy-message-content h3,\n.journy-message-content h4,\n.journy-message-content h5,\n.journy-message-content h6 {\n  margin: 16px 0 12px 0;\n  font-weight: 600;\n  line-height: 1.3;\n  color: #111827;\n}\n\n.journy-message-content h1 {\n  font-size: 24px;\n}\n\n.journy-message-content h2 {\n  font-size: 20px;\n}\n\n.journy-message-content h3 {\n  font-size: 18px;\n}\n\n.journy-message-content h4 {\n  font-size: 16px;\n}\n\n.journy-message-content h5,\n.journy-message-content h6 {\n  font-size: 14px;\n}\n\n/* Code blocks */\n.journy-message-content code {\n  background-color: #f3f4f6;\n  color: #ef4444;\n  padding: 2px 6px;\n  border-radius: 4px;\n  font-size: 0.9em;\n  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'source-code-pro', monospace;\n}\n\n.journy-message-content pre {\n  background-color: #1f2937;\n  color: #f9fafb;\n  padding: 16px;\n  border-radius: 8px;\n  overflow-x: auto;\n  margin: 12px 0;\n  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'source-code-pro', monospace;\n  font-size: 14px;\n  line-height: 1.5;\n}\n\n.journy-message-content pre code {\n  background-color: transparent;\n  color: inherit;\n  padding: 0;\n  border-radius: 0;\n  font-size: inherit;\n}\n\n/* Text formatting */\n.journy-message-content u {\n  text-decoration: underline;\n}\n\n.journy-message-content s,\n.journy-message-content strike,\n.journy-message-content del {\n  text-decoration: line-through;\n}\n\n.journy-message-content strong {\n  font-weight: 600;\n}\n\n.journy-message-content em {\n  font-style: italic;\n}\n\n/* Blockquotes */\n.journy-message-content blockquote {\n  border-left: 4px solid #e5e7eb;\n  padding-left: 16px;\n  margin: 12px 0;\n  color: #6b7280;\n  font-style: italic;\n}\n\n/* Tables */\n.journy-message-content table {\n  width: 100%;\n  border-collapse: collapse;\n  margin: 12px 0;\n}\n\n.journy-message-content th,\n.journy-message-content td {\n  border: 1px solid #e5e7eb;\n  padding: 8px 12px;\n  text-align: left;\n}\n\n.journy-message-content th {\n  background-color: #f9fafb;\n  font-weight: 600;\n}\n\n/* Horizontal rule */\n.journy-message-content hr {\n  border: none;\n  border-top: 1px solid #e5e7eb;\n  margin: 16px 0;\n}\n\n.journy-message-actions {\n  display: flex;\n  gap: 12px;\n  margin-top: 20px;\n  flex-wrap: wrap;\n}\n\n.journy-message-action {\n  padding: 10px 20px;\n  border-radius: 6px;\n  font-size: 14px;\n  font-weight: 500;\n  cursor: pointer;\n  border: none;\n  transition: all 0.2s;\n}\n\n.journy-message-action-primary {\n  background-color: #3b82f6;\n  color: white;\n}\n\n.journy-message-action-primary:hover {\n  background-color: #2563eb;\n}\n\n.journy-message-action-secondary {\n  background-color: #e5e7eb;\n  color: #374151;\n}\n\n.journy-message-action-secondary:hover {\n  background-color: #d1d5db;\n}\n\n.journy-message-action-link {\n  background: none;\n  color: #3b82f6;\n  text-decoration: underline;\n  padding: 10px 0;\n}\n\n.journy-message-action-link:hover {\n  color: #2563eb;\n}\n\n/* Settings Panel */\n.journy-settings-panel {\n  position: absolute;\n  top: 0;\n  right: 0;\n  bottom: 0;\n  width: 100%;\n  background: white;\n  z-index: 10;\n  display: flex;\n  flex-direction: column;\n  transform: translateX(100%);\n  transition: transform 0.3s ease;\n}\n\n.journy-settings-panel-open {\n  transform: translateX(0);\n}\n\n.journy-settings-panel-closed {\n  transform: translateX(100%);\n}\n\n.journy-settings-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 12px 16px;\n  background: #f9fafb;\n  border-bottom: 1px solid #e5e7eb;\n  flex-shrink: 0;\n}\n\n.journy-settings-title {\n  font-size: 14px;\n  font-weight: 600;\n  color: #111827;\n}\n\n.journy-settings-close {\n  background: none;\n  border: none;\n  font-size: 18px;\n  line-height: 1;\n  cursor: pointer;\n  color: #6b7280;\n  padding: 4px 8px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n}\n\n.journy-settings-close:hover {\n  background-color: #e5e7eb;\n  color: #374151;\n}\n\n.journy-settings-body {\n  padding: 16px;\n  overflow-y: auto;\n  flex: 1;\n}\n\n.journy-settings-item {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 12px 0;\n  border-bottom: 1px solid #f3f4f6;\n}\n\n.journy-settings-item:last-child {\n  border-bottom: none;\n}\n\n.journy-settings-label {\n  font-size: 13px;\n  font-weight: 500;\n  color: #374151;\n}\n\n.journy-settings-select {\n  padding: 6px 10px;\n  border: 1px solid #d1d5db;\n  border-radius: 6px;\n  font-size: 13px;\n  color: #374151;\n  background: white;\n  cursor: pointer;\n  outline: none;\n  transition: border-color 0.2s;\n}\n\n.journy-settings-select:focus {\n  border-color: #3b82f6;\n}\n\n.journy-settings-toggle {\n  position: relative;\n  width: 40px;\n  height: 22px;\n  border-radius: 11px;\n  border: none;\n  background: #d1d5db;\n  cursor: pointer;\n  padding: 0;\n  transition: background-color 0.2s;\n  flex-shrink: 0;\n}\n\n.journy-settings-toggle-on {\n  background: #3b82f6;\n}\n\n.journy-settings-toggle-knob {\n  position: absolute;\n  top: 2px;\n  left: 2px;\n  width: 18px;\n  height: 18px;\n  border-radius: 50%;\n  background: white;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);\n  transition: transform 0.2s;\n}\n\n.journy-settings-toggle-on .journy-settings-toggle-knob {\n  transform: translateX(18px);\n}\n\n.journy-settings-item-vertical {\n  flex-direction: column;\n  align-items: flex-start;\n  gap: 6px;\n}\n\n.journy-settings-input {\n  width: 100%;\n  padding: 6px 10px;\n  border: 1px solid #d1d5db;\n  border-radius: 6px;\n  font-size: 13px;\n  color: #374151;\n  background: white;\n  outline: none;\n  transition: border-color 0.2s;\n  box-sizing: border-box;\n}\n\n.journy-settings-input:focus {\n  border-color: #3b82f6;\n}\n\n.journy-settings-input::placeholder {\n  color: #9ca3af;\n}\n\n.journy-settings-value {\n  font-size: 13px;\n  color: #6b7280;\n  font-weight: 400;\n  max-width: 60%;\n  text-align: right;\n  word-break: break-all;\n}\n\n.journy-message-widget-empty {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  color: #9ca3af;\n  font-size: 14px;\n  flex: 1;\n  min-height: 80px;\n}\n\n.journy-settings-advanced-btn {\n  background: none;\n  border: none;\n  font-size: 13px;\n  font-weight: 500;\n  color: #6b7280;\n  cursor: pointer;\n  padding: 0;\n  transition: color 0.2s;\n}\n\n.journy-settings-advanced-btn:hover {\n  color: #374151;\n}\n\n.journy-message-widget-settings-btn {\n  background: none;\n  border: none;\n  font-size: 16px;\n  line-height: 1;\n  cursor: pointer;\n  color: #6b7280;\n  padding: 4px 8px;\n  border-radius: 4px;\n  transition: background-color 0.2s, color 0.2s;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n}\n\n.journy-message-widget-settings-btn:hover {\n  background-color: #e5e7eb;\n  color: #374151;\n}\n\n/* Responsive design */\n@media (max-width: 640px) {\n  .journy-message-widget {\n    min-width: calc(100vw - 32px);\n    max-width: calc(100vw - 32px);\n    left: 16px !important;\n    right: 16px !important;\n  }\n\n  .journy-message-popup {\n    width: 95%;\n    padding: 20px;\n  }\n\n  .journy-message-title {\n    font-size: 18px;\n  }\n\n  .journy-message-content {\n    font-size: 14px;\n  }\n\n  .journy-message-actions {\n    flex-direction: column;\n  }\n\n  .journy-message-action {\n    width: 100%;\n  }\n}\n";

function useMessagingStore(store) {
    const [state, setState] = useState(() => store.getState());
    useEffect(() => {
        // Sync in case state changed between render and effect
        setState(store.getState());
        return store.subscribe(() => setState(store.getState()));
    }, [store]);
    return state;
}

/*! @license DOMPurify 3.3.1 | (c) Cure53 and other contributors | Released under the Apache license 2.0 and Mozilla Public License 2.0 | github.com/cure53/DOMPurify/blob/3.3.1/LICENSE */

const {
  entries,
  setPrototypeOf,
  isFrozen,
  getPrototypeOf,
  getOwnPropertyDescriptor
} = Object;
let {
  freeze,
  seal,
  create
} = Object; // eslint-disable-line import/no-mutable-exports
let {
  apply,
  construct
} = typeof Reflect !== 'undefined' && Reflect;
if (!freeze) {
  freeze = function freeze(x) {
    return x;
  };
}
if (!seal) {
  seal = function seal(x) {
    return x;
  };
}
if (!apply) {
  apply = function apply(func, thisArg) {
    for (var _len = arguments.length, args = new Array(_len > 2 ? _len - 2 : 0), _key = 2; _key < _len; _key++) {
      args[_key - 2] = arguments[_key];
    }
    return func.apply(thisArg, args);
  };
}
if (!construct) {
  construct = function construct(Func) {
    for (var _len2 = arguments.length, args = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) {
      args[_key2 - 1] = arguments[_key2];
    }
    return new Func(...args);
  };
}
const arrayForEach = unapply(Array.prototype.forEach);
const arrayLastIndexOf = unapply(Array.prototype.lastIndexOf);
const arrayPop = unapply(Array.prototype.pop);
const arrayPush = unapply(Array.prototype.push);
const arraySplice = unapply(Array.prototype.splice);
const stringToLowerCase = unapply(String.prototype.toLowerCase);
const stringToString = unapply(String.prototype.toString);
const stringMatch = unapply(String.prototype.match);
const stringReplace = unapply(String.prototype.replace);
const stringIndexOf = unapply(String.prototype.indexOf);
const stringTrim = unapply(String.prototype.trim);
const objectHasOwnProperty = unapply(Object.prototype.hasOwnProperty);
const regExpTest = unapply(RegExp.prototype.test);
const typeErrorCreate = unconstruct(TypeError);
/**
 * Creates a new function that calls the given function with a specified thisArg and arguments.
 *
 * @param func - The function to be wrapped and called.
 * @returns A new function that calls the given function with a specified thisArg and arguments.
 */
function unapply(func) {
  return function (thisArg) {
    if (thisArg instanceof RegExp) {
      thisArg.lastIndex = 0;
    }
    for (var _len3 = arguments.length, args = new Array(_len3 > 1 ? _len3 - 1 : 0), _key3 = 1; _key3 < _len3; _key3++) {
      args[_key3 - 1] = arguments[_key3];
    }
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
  return function () {
    for (var _len4 = arguments.length, args = new Array(_len4), _key4 = 0; _key4 < _len4; _key4++) {
      args[_key4] = arguments[_key4];
    }
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
  let transformCaseFunc = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : stringToLowerCase;
  if (setPrototypeOf) {
    // Make 'in' and truthy checks like Boolean(set.constructor)
    // independent of any properties defined on Object.prototype.
    // Prevent prototype setters from intercepting set as a this value.
    setPrototypeOf(set, null);
  }
  let l = array.length;
  while (l--) {
    let element = array[l];
    if (typeof element === 'string') {
      const lcElement = transformCaseFunc(element);
      if (lcElement !== element) {
        // Config presets (e.g. tags.js, attrs.js) are immutable.
        if (!isFrozen(array)) {
          array[l] = lcElement;
        }
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
  for (let index = 0; index < array.length; index++) {
    const isPropertyExist = objectHasOwnProperty(array, index);
    if (!isPropertyExist) {
      array[index] = null;
    }
  }
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
  for (const [property, value] of entries(object)) {
    const isPropertyExist = objectHasOwnProperty(object, property);
    if (isPropertyExist) {
      if (Array.isArray(value)) {
        newObject[property] = cleanArray(value);
      } else if (value && typeof value === 'object' && value.constructor === Object) {
        newObject[property] = clone(value);
      } else {
        newObject[property] = value;
      }
    }
  }
  return newObject;
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
      if (desc.get) {
        return unapply(desc.get);
      }
      if (typeof desc.value === 'function') {
        return unapply(desc.value);
      }
    }
    object = getPrototypeOf(object);
  }
  function fallbackValue() {
    return null;
  }
  return fallbackValue;
}

const html$1 = freeze(['a', 'abbr', 'acronym', 'address', 'area', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo', 'big', 'blink', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'content', 'data', 'datalist', 'dd', 'decorator', 'del', 'details', 'dfn', 'dialog', 'dir', 'div', 'dl', 'dt', 'element', 'em', 'fieldset', 'figcaption', 'figure', 'font', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'main', 'map', 'mark', 'marquee', 'menu', 'menuitem', 'meter', 'nav', 'nobr', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'search', 'section', 'select', 'shadow', 'slot', 'small', 'source', 'spacer', 'span', 'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'track', 'tt', 'u', 'ul', 'var', 'video', 'wbr']);
const svg$1 = freeze(['svg', 'a', 'altglyph', 'altglyphdef', 'altglyphitem', 'animatecolor', 'animatemotion', 'animatetransform', 'circle', 'clippath', 'defs', 'desc', 'ellipse', 'enterkeyhint', 'exportparts', 'filter', 'font', 'g', 'glyph', 'glyphref', 'hkern', 'image', 'inputmode', 'line', 'lineargradient', 'marker', 'mask', 'metadata', 'mpath', 'part', 'path', 'pattern', 'polygon', 'polyline', 'radialgradient', 'rect', 'stop', 'style', 'switch', 'symbol', 'text', 'textpath', 'title', 'tref', 'tspan', 'view', 'vkern']);
const svgFilters = freeze(['feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence']);
// List of SVG elements that are disallowed by default.
// We still need to know them so that we can do namespace
// checks properly in case one wants to add them to
// allow-list.
const svgDisallowed = freeze(['animate', 'color-profile', 'cursor', 'discard', 'font-face', 'font-face-format', 'font-face-name', 'font-face-src', 'font-face-uri', 'foreignobject', 'hatch', 'hatchpath', 'mesh', 'meshgradient', 'meshpatch', 'meshrow', 'missing-glyph', 'script', 'set', 'solidcolor', 'unknown', 'use']);
const mathMl$1 = freeze(['math', 'menclose', 'merror', 'mfenced', 'mfrac', 'mglyph', 'mi', 'mlabeledtr', 'mmultiscripts', 'mn', 'mo', 'mover', 'mpadded', 'mphantom', 'mroot', 'mrow', 'ms', 'mspace', 'msqrt', 'mstyle', 'msub', 'msup', 'msubsup', 'mtable', 'mtd', 'mtext', 'mtr', 'munder', 'munderover', 'mprescripts']);
// Similarly to SVG, we want to know all MathML elements,
// even those that we disallow by default.
const mathMlDisallowed = freeze(['maction', 'maligngroup', 'malignmark', 'mlongdiv', 'mscarries', 'mscarry', 'msgroup', 'mstack', 'msline', 'msrow', 'semantics', 'annotation', 'annotation-xml', 'mprescripts', 'none']);
const text = freeze(['#text']);

const html = freeze(['accept', 'action', 'align', 'alt', 'autocapitalize', 'autocomplete', 'autopictureinpicture', 'autoplay', 'background', 'bgcolor', 'border', 'capture', 'cellpadding', 'cellspacing', 'checked', 'cite', 'class', 'clear', 'color', 'cols', 'colspan', 'controls', 'controlslist', 'coords', 'crossorigin', 'datetime', 'decoding', 'default', 'dir', 'disabled', 'disablepictureinpicture', 'disableremoteplayback', 'download', 'draggable', 'enctype', 'enterkeyhint', 'exportparts', 'face', 'for', 'headers', 'height', 'hidden', 'high', 'href', 'hreflang', 'id', 'inert', 'inputmode', 'integrity', 'ismap', 'kind', 'label', 'lang', 'list', 'loading', 'loop', 'low', 'max', 'maxlength', 'media', 'method', 'min', 'minlength', 'multiple', 'muted', 'name', 'nonce', 'noshade', 'novalidate', 'nowrap', 'open', 'optimum', 'part', 'pattern', 'placeholder', 'playsinline', 'popover', 'popovertarget', 'popovertargetaction', 'poster', 'preload', 'pubdate', 'radiogroup', 'readonly', 'rel', 'required', 'rev', 'reversed', 'role', 'rows', 'rowspan', 'spellcheck', 'scope', 'selected', 'shape', 'size', 'sizes', 'slot', 'span', 'srclang', 'start', 'src', 'srcset', 'step', 'style', 'summary', 'tabindex', 'title', 'translate', 'type', 'usemap', 'valign', 'value', 'width', 'wrap', 'xmlns', 'slot']);
const svg = freeze(['accent-height', 'accumulate', 'additive', 'alignment-baseline', 'amplitude', 'ascent', 'attributename', 'attributetype', 'azimuth', 'basefrequency', 'baseline-shift', 'begin', 'bias', 'by', 'class', 'clip', 'clippathunits', 'clip-path', 'clip-rule', 'color', 'color-interpolation', 'color-interpolation-filters', 'color-profile', 'color-rendering', 'cx', 'cy', 'd', 'dx', 'dy', 'diffuseconstant', 'direction', 'display', 'divisor', 'dur', 'edgemode', 'elevation', 'end', 'exponent', 'fill', 'fill-opacity', 'fill-rule', 'filter', 'filterunits', 'flood-color', 'flood-opacity', 'font-family', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style', 'font-variant', 'font-weight', 'fx', 'fy', 'g1', 'g2', 'glyph-name', 'glyphref', 'gradientunits', 'gradienttransform', 'height', 'href', 'id', 'image-rendering', 'in', 'in2', 'intercept', 'k', 'k1', 'k2', 'k3', 'k4', 'kerning', 'keypoints', 'keysplines', 'keytimes', 'lang', 'lengthadjust', 'letter-spacing', 'kernelmatrix', 'kernelunitlength', 'lighting-color', 'local', 'marker-end', 'marker-mid', 'marker-start', 'markerheight', 'markerunits', 'markerwidth', 'maskcontentunits', 'maskunits', 'max', 'mask', 'mask-type', 'media', 'method', 'mode', 'min', 'name', 'numoctaves', 'offset', 'operator', 'opacity', 'order', 'orient', 'orientation', 'origin', 'overflow', 'paint-order', 'path', 'pathlength', 'patterncontentunits', 'patterntransform', 'patternunits', 'points', 'preservealpha', 'preserveaspectratio', 'primitiveunits', 'r', 'rx', 'ry', 'radius', 'refx', 'refy', 'repeatcount', 'repeatdur', 'restart', 'result', 'rotate', 'scale', 'seed', 'shape-rendering', 'slope', 'specularconstant', 'specularexponent', 'spreadmethod', 'startoffset', 'stddeviation', 'stitchtiles', 'stop-color', 'stop-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke', 'stroke-width', 'style', 'surfacescale', 'systemlanguage', 'tabindex', 'tablevalues', 'targetx', 'targety', 'transform', 'transform-origin', 'text-anchor', 'text-decoration', 'text-rendering', 'textlength', 'type', 'u1', 'u2', 'unicode', 'values', 'viewbox', 'visibility', 'version', 'vert-adv-y', 'vert-origin-x', 'vert-origin-y', 'width', 'word-spacing', 'wrap', 'writing-mode', 'xchannelselector', 'ychannelselector', 'x', 'x1', 'x2', 'xmlns', 'y', 'y1', 'y2', 'z', 'zoomandpan']);
const mathMl = freeze(['accent', 'accentunder', 'align', 'bevelled', 'close', 'columnsalign', 'columnlines', 'columnspan', 'denomalign', 'depth', 'dir', 'display', 'displaystyle', 'encoding', 'fence', 'frame', 'height', 'href', 'id', 'largeop', 'length', 'linethickness', 'lspace', 'lquote', 'mathbackground', 'mathcolor', 'mathsize', 'mathvariant', 'maxsize', 'minsize', 'movablelimits', 'notation', 'numalign', 'open', 'rowalign', 'rowlines', 'rowspacing', 'rowspan', 'rspace', 'rquote', 'scriptlevel', 'scriptminsize', 'scriptsizemultiplier', 'selection', 'separator', 'separators', 'stretchy', 'subscriptshift', 'supscriptshift', 'symmetric', 'voffset', 'width', 'xmlns']);
const xml = freeze(['xlink:href', 'xml:id', 'xlink:title', 'xml:space', 'xmlns:xlink']);

// eslint-disable-next-line unicorn/better-regex
const MUSTACHE_EXPR = seal(/\{\{[\w\W]*|[\w\W]*\}\}/gm); // Specify template detection regex for SAFE_FOR_TEMPLATES mode
const ERB_EXPR = seal(/<%[\w\W]*|[\w\W]*%>/gm);
const TMPLIT_EXPR = seal(/\$\{[\w\W]*/gm); // eslint-disable-line unicorn/better-regex
const DATA_ATTR = seal(/^data-[\-\w.\u00B7-\uFFFF]+$/); // eslint-disable-line no-useless-escape
const ARIA_ATTR = seal(/^aria-[\-\w]+$/); // eslint-disable-line no-useless-escape
const IS_ALLOWED_URI = seal(/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i // eslint-disable-line no-useless-escape
);
const IS_SCRIPT_OR_DATA = seal(/^(?:\w+script|data):/i);
const ATTR_WHITESPACE = seal(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g // eslint-disable-line no-control-regex
);
const DOCTYPE_NAME = seal(/^html$/i);
const CUSTOM_ELEMENT = seal(/^[a-z][.\w]*(-[.\w]+)+$/i);

var EXPRESSIONS = /*#__PURE__*/Object.freeze({
  __proto__: null,
  ARIA_ATTR: ARIA_ATTR,
  ATTR_WHITESPACE: ATTR_WHITESPACE,
  CUSTOM_ELEMENT: CUSTOM_ELEMENT,
  DATA_ATTR: DATA_ATTR,
  DOCTYPE_NAME: DOCTYPE_NAME,
  ERB_EXPR: ERB_EXPR,
  IS_ALLOWED_URI: IS_ALLOWED_URI,
  IS_SCRIPT_OR_DATA: IS_SCRIPT_OR_DATA,
  MUSTACHE_EXPR: MUSTACHE_EXPR,
  TMPLIT_EXPR: TMPLIT_EXPR
});

/* eslint-disable @typescript-eslint/indent */
// https://developer.mozilla.org/en-US/docs/Web/API/Node/nodeType
const NODE_TYPE = {
  element: 1,
  text: 3,
  // Deprecated
  progressingInstruction: 7,
  comment: 8,
  document: 9};
const getGlobal = function getGlobal() {
  return typeof window === 'undefined' ? null : window;
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
  if (typeof trustedTypes !== 'object' || typeof trustedTypes.createPolicy !== 'function') {
    return null;
  }
  // Allow the callers to control the unique policy name
  // by adding a data-tt-policy-suffix to the script element with the DOMPurify.
  // Policy creation with duplicate names throws in Trusted Types.
  let suffix = null;
  const ATTR_NAME = 'data-tt-policy-suffix';
  if (purifyHostElement && purifyHostElement.hasAttribute(ATTR_NAME)) {
    suffix = purifyHostElement.getAttribute(ATTR_NAME);
  }
  const policyName = 'dompurify' + (suffix ? '#' + suffix : '');
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
    // Policy creation failed (most likely another DOMPurify script has
    // already run). Skip creating the policy, as this will only cause errors
    // if TT are enforced.
    console.warn('TrustedTypes policy ' + policyName + ' could not be created.');
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
function createDOMPurify() {
  let window = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : getGlobal();
  const DOMPurify = root => createDOMPurify(root);
  DOMPurify.version = '3.3.1';
  DOMPurify.removed = [];
  if (!window || !window.document || window.document.nodeType !== NODE_TYPE.document || !window.Element) {
    // Not running in a browser, provide a factory function
    // so that you can pass your own Window
    DOMPurify.isSupported = false;
    return DOMPurify;
  }
  let {
    document
  } = window;
  const originalDocument = document;
  const currentScript = originalDocument.currentScript;
  const {
    DocumentFragment,
    HTMLTemplateElement,
    Node,
    Element,
    NodeFilter,
    NamedNodeMap = window.NamedNodeMap || window.MozNamedAttrMap,
    HTMLFormElement,
    DOMParser,
    trustedTypes
  } = window;
  const ElementPrototype = Element.prototype;
  const cloneNode = lookupGetter(ElementPrototype, 'cloneNode');
  const remove = lookupGetter(ElementPrototype, 'remove');
  const getNextSibling = lookupGetter(ElementPrototype, 'nextSibling');
  const getChildNodes = lookupGetter(ElementPrototype, 'childNodes');
  const getParentNode = lookupGetter(ElementPrototype, 'parentNode');
  // As per issue #47, the web-components registry is inherited by a
  // new document created via createHTMLDocument. As per the spec
  // (http://w3c.github.io/webcomponents/spec/custom/#creating-and-passing-registries)
  // a new empty registry is used when creating a template contents owner
  // document, so we use that as our parent document to ensure nothing
  // is inherited.
  if (typeof HTMLTemplateElement === 'function') {
    const template = document.createElement('template');
    if (template.content && template.content.ownerDocument) {
      document = template.content.ownerDocument;
    }
  }
  let trustedTypesPolicy;
  let emptyHTML = '';
  const {
    implementation,
    createNodeIterator,
    createDocumentFragment,
    getElementsByTagName
  } = document;
  const {
    importNode
  } = originalDocument;
  let hooks = _createHooksMap();
  /**
   * Expose whether this browser supports running the full DOMPurify.
   */
  DOMPurify.isSupported = typeof entries === 'function' && typeof getParentNode === 'function' && implementation && implementation.createHTMLDocument !== undefined;
  const {
    MUSTACHE_EXPR,
    ERB_EXPR,
    TMPLIT_EXPR,
    DATA_ATTR,
    ARIA_ATTR,
    IS_SCRIPT_OR_DATA,
    ATTR_WHITESPACE,
    CUSTOM_ELEMENT
  } = EXPRESSIONS;
  let {
    IS_ALLOWED_URI: IS_ALLOWED_URI$1
  } = EXPRESSIONS;
  /**
   * We consider the elements and attributes below to be safe. Ideally
   * don't add any new ones but feel free to remove unwanted ones.
   */
  /* allowed element names */
  let ALLOWED_TAGS = null;
  const DEFAULT_ALLOWED_TAGS = addToSet({}, [...html$1, ...svg$1, ...svgFilters, ...mathMl$1, ...text]);
  /* Allowed attribute names */
  let ALLOWED_ATTR = null;
  const DEFAULT_ALLOWED_ATTR = addToSet({}, [...html, ...svg, ...mathMl, ...xml]);
  /*
   * Configure how DOMPurify should handle custom elements and their attributes as well as customized built-in elements.
   * @property {RegExp|Function|null} tagNameCheck one of [null, regexPattern, predicate]. Default: `null` (disallow any custom elements)
   * @property {RegExp|Function|null} attributeNameCheck one of [null, regexPattern, predicate]. Default: `null` (disallow any attributes not on the allow list)
   * @property {boolean} allowCustomizedBuiltInElements allow custom elements derived from built-ins if they pass CUSTOM_ELEMENT_HANDLING.tagNameCheck. Default: `false`.
   */
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
  /* Explicitly forbidden tags (overrides ALLOWED_TAGS/ADD_TAGS) */
  let FORBID_TAGS = null;
  /* Explicitly forbidden attributes (overrides ALLOWED_ATTR/ADD_ATTR) */
  let FORBID_ATTR = null;
  /* Config object to store ADD_TAGS/ADD_ATTR functions (when used as functions) */
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
  /* Decide if ARIA attributes are okay */
  let ALLOW_ARIA_ATTR = true;
  /* Decide if custom data attributes are okay */
  let ALLOW_DATA_ATTR = true;
  /* Decide if unknown protocols are okay */
  let ALLOW_UNKNOWN_PROTOCOLS = false;
  /* Decide if self-closing tags in attributes are allowed.
   * Usually removed due to a mXSS issue in jQuery 3.0 */
  let ALLOW_SELF_CLOSE_IN_ATTR = true;
  /* Output should be safe for common template engines.
   * This means, DOMPurify removes data attributes, mustaches and ERB
   */
  let SAFE_FOR_TEMPLATES = false;
  /* Output should be safe even for XML used within HTML and alike.
   * This means, DOMPurify removes comments when containing risky content.
   */
  let SAFE_FOR_XML = true;
  /* Decide if document with <html>... should be returned */
  let WHOLE_DOCUMENT = false;
  /* Track whether config is already set on this instance of DOMPurify. */
  let SET_CONFIG = false;
  /* Decide if all elements (e.g. style, script) must be children of
   * document.body. By default, browsers might move them to document.head */
  let FORCE_BODY = false;
  /* Decide if a DOM `HTMLBodyElement` should be returned, instead of a html
   * string (or a TrustedHTML object if Trusted Types are supported).
   * If `WHOLE_DOCUMENT` is enabled a `HTMLHtmlElement` will be returned instead
   */
  let RETURN_DOM = false;
  /* Decide if a DOM `DocumentFragment` should be returned, instead of a html
   * string  (or a TrustedHTML object if Trusted Types are supported) */
  let RETURN_DOM_FRAGMENT = false;
  /* Try to return a Trusted Type object instead of a string, return a string in
   * case Trusted Types are not supported  */
  let RETURN_TRUSTED_TYPE = false;
  /* Output should be free from DOM clobbering attacks?
   * This sanitizes markups named with colliding, clobberable built-in DOM APIs.
   */
  let SANITIZE_DOM = true;
  /* Achieve full DOM Clobbering protection by isolating the namespace of named
   * properties and JS variables, mitigating attacks that abuse the HTML/DOM spec rules.
   *
   * HTML/DOM spec rules that enable DOM Clobbering:
   *   - Named Access on Window (§7.3.3)
   *   - DOM Tree Accessors (§3.1.5)
   *   - Form Element Parent-Child Relations (§4.10.3)
   *   - Iframe srcdoc / Nested WindowProxies (§4.8.5)
   *   - HTMLCollection (§4.2.10.2)
   *
   * Namespace isolation is implemented by prefixing `id` and `name` attributes
   * with a constant string, i.e., `user-content-`
   */
  let SANITIZE_NAMED_PROPS = false;
  const SANITIZE_NAMED_PROPS_PREFIX = 'user-content-';
  /* Keep element content when removing element? */
  let KEEP_CONTENT = true;
  /* If a `Node` is passed to sanitize(), then performs sanitization in-place instead
   * of importing it into a new Document and returning a sanitized copy */
  let IN_PLACE = false;
  /* Allow usage of profiles like html, svg and mathMl */
  let USE_PROFILES = {};
  /* Tags to ignore content of when KEEP_CONTENT is true */
  let FORBID_CONTENTS = null;
  const DEFAULT_FORBID_CONTENTS = addToSet({}, ['annotation-xml', 'audio', 'colgroup', 'desc', 'foreignobject', 'head', 'iframe', 'math', 'mi', 'mn', 'mo', 'ms', 'mtext', 'noembed', 'noframes', 'noscript', 'plaintext', 'script', 'style', 'svg', 'template', 'thead', 'title', 'video', 'xmp']);
  /* Tags that are safe for data: URIs */
  let DATA_URI_TAGS = null;
  const DEFAULT_DATA_URI_TAGS = addToSet({}, ['audio', 'video', 'img', 'source', 'image', 'track']);
  /* Attributes safe for values like "javascript:" */
  let URI_SAFE_ATTRIBUTES = null;
  const DEFAULT_URI_SAFE_ATTRIBUTES = addToSet({}, ['alt', 'class', 'for', 'id', 'label', 'name', 'pattern', 'placeholder', 'role', 'summary', 'title', 'value', 'style', 'xmlns']);
  const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
  /* Document namespace */
  let NAMESPACE = HTML_NAMESPACE;
  let IS_EMPTY_INPUT = false;
  /* Allowed XHTML+XML namespaces */
  let ALLOWED_NAMESPACES = null;
  const DEFAULT_ALLOWED_NAMESPACES = addToSet({}, [MATHML_NAMESPACE, SVG_NAMESPACE, HTML_NAMESPACE], stringToString);
  let MATHML_TEXT_INTEGRATION_POINTS = addToSet({}, ['mi', 'mo', 'mn', 'ms', 'mtext']);
  let HTML_INTEGRATION_POINTS = addToSet({}, ['annotation-xml']);
  // Certain elements are allowed in both SVG and HTML
  // namespace. We need to specify them explicitly
  // so that they don't get erroneously deleted from
  // HTML namespace.
  const COMMON_SVG_AND_HTML_ELEMENTS = addToSet({}, ['title', 'style', 'font', 'a', 'script']);
  /* Parsing of strict XHTML documents */
  let PARSER_MEDIA_TYPE = null;
  const SUPPORTED_PARSER_MEDIA_TYPES = ['application/xhtml+xml', 'text/html'];
  const DEFAULT_PARSER_MEDIA_TYPE = 'text/html';
  let transformCaseFunc = null;
  /* Keep a reference to config to pass to hooks */
  let CONFIG = null;
  /* Ideally, do not touch anything below this line */
  /* ______________________________________________ */
  const formElement = document.createElement('form');
  const isRegexOrFunction = function isRegexOrFunction(testValue) {
    return testValue instanceof RegExp || testValue instanceof Function;
  };
  /**
   * _parseConfig
   *
   * @param cfg optional config literal
   */
  // eslint-disable-next-line complexity
  const _parseConfig = function _parseConfig() {
    let cfg = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    if (CONFIG && CONFIG === cfg) {
      return;
    }
    /* Shield configuration object from tampering */
    if (!cfg || typeof cfg !== 'object') {
      cfg = {};
    }
    /* Shield configuration object from prototype pollution */
    cfg = clone(cfg);
    PARSER_MEDIA_TYPE =
    // eslint-disable-next-line unicorn/prefer-includes
    SUPPORTED_PARSER_MEDIA_TYPES.indexOf(cfg.PARSER_MEDIA_TYPE) === -1 ? DEFAULT_PARSER_MEDIA_TYPE : cfg.PARSER_MEDIA_TYPE;
    // HTML tags and attributes are not case-sensitive, converting to lowercase. Keeping XHTML as is.
    transformCaseFunc = PARSER_MEDIA_TYPE === 'application/xhtml+xml' ? stringToString : stringToLowerCase;
    /* Set configuration parameters */
    ALLOWED_TAGS = objectHasOwnProperty(cfg, 'ALLOWED_TAGS') ? addToSet({}, cfg.ALLOWED_TAGS, transformCaseFunc) : DEFAULT_ALLOWED_TAGS;
    ALLOWED_ATTR = objectHasOwnProperty(cfg, 'ALLOWED_ATTR') ? addToSet({}, cfg.ALLOWED_ATTR, transformCaseFunc) : DEFAULT_ALLOWED_ATTR;
    ALLOWED_NAMESPACES = objectHasOwnProperty(cfg, 'ALLOWED_NAMESPACES') ? addToSet({}, cfg.ALLOWED_NAMESPACES, stringToString) : DEFAULT_ALLOWED_NAMESPACES;
    URI_SAFE_ATTRIBUTES = objectHasOwnProperty(cfg, 'ADD_URI_SAFE_ATTR') ? addToSet(clone(DEFAULT_URI_SAFE_ATTRIBUTES), cfg.ADD_URI_SAFE_ATTR, transformCaseFunc) : DEFAULT_URI_SAFE_ATTRIBUTES;
    DATA_URI_TAGS = objectHasOwnProperty(cfg, 'ADD_DATA_URI_TAGS') ? addToSet(clone(DEFAULT_DATA_URI_TAGS), cfg.ADD_DATA_URI_TAGS, transformCaseFunc) : DEFAULT_DATA_URI_TAGS;
    FORBID_CONTENTS = objectHasOwnProperty(cfg, 'FORBID_CONTENTS') ? addToSet({}, cfg.FORBID_CONTENTS, transformCaseFunc) : DEFAULT_FORBID_CONTENTS;
    FORBID_TAGS = objectHasOwnProperty(cfg, 'FORBID_TAGS') ? addToSet({}, cfg.FORBID_TAGS, transformCaseFunc) : clone({});
    FORBID_ATTR = objectHasOwnProperty(cfg, 'FORBID_ATTR') ? addToSet({}, cfg.FORBID_ATTR, transformCaseFunc) : clone({});
    USE_PROFILES = objectHasOwnProperty(cfg, 'USE_PROFILES') ? cfg.USE_PROFILES : false;
    ALLOW_ARIA_ATTR = cfg.ALLOW_ARIA_ATTR !== false; // Default true
    ALLOW_DATA_ATTR = cfg.ALLOW_DATA_ATTR !== false; // Default true
    ALLOW_UNKNOWN_PROTOCOLS = cfg.ALLOW_UNKNOWN_PROTOCOLS || false; // Default false
    ALLOW_SELF_CLOSE_IN_ATTR = cfg.ALLOW_SELF_CLOSE_IN_ATTR !== false; // Default true
    SAFE_FOR_TEMPLATES = cfg.SAFE_FOR_TEMPLATES || false; // Default false
    SAFE_FOR_XML = cfg.SAFE_FOR_XML !== false; // Default true
    WHOLE_DOCUMENT = cfg.WHOLE_DOCUMENT || false; // Default false
    RETURN_DOM = cfg.RETURN_DOM || false; // Default false
    RETURN_DOM_FRAGMENT = cfg.RETURN_DOM_FRAGMENT || false; // Default false
    RETURN_TRUSTED_TYPE = cfg.RETURN_TRUSTED_TYPE || false; // Default false
    FORCE_BODY = cfg.FORCE_BODY || false; // Default false
    SANITIZE_DOM = cfg.SANITIZE_DOM !== false; // Default true
    SANITIZE_NAMED_PROPS = cfg.SANITIZE_NAMED_PROPS || false; // Default false
    KEEP_CONTENT = cfg.KEEP_CONTENT !== false; // Default true
    IN_PLACE = cfg.IN_PLACE || false; // Default false
    IS_ALLOWED_URI$1 = cfg.ALLOWED_URI_REGEXP || IS_ALLOWED_URI;
    NAMESPACE = cfg.NAMESPACE || HTML_NAMESPACE;
    MATHML_TEXT_INTEGRATION_POINTS = cfg.MATHML_TEXT_INTEGRATION_POINTS || MATHML_TEXT_INTEGRATION_POINTS;
    HTML_INTEGRATION_POINTS = cfg.HTML_INTEGRATION_POINTS || HTML_INTEGRATION_POINTS;
    CUSTOM_ELEMENT_HANDLING = cfg.CUSTOM_ELEMENT_HANDLING || {};
    if (cfg.CUSTOM_ELEMENT_HANDLING && isRegexOrFunction(cfg.CUSTOM_ELEMENT_HANDLING.tagNameCheck)) {
      CUSTOM_ELEMENT_HANDLING.tagNameCheck = cfg.CUSTOM_ELEMENT_HANDLING.tagNameCheck;
    }
    if (cfg.CUSTOM_ELEMENT_HANDLING && isRegexOrFunction(cfg.CUSTOM_ELEMENT_HANDLING.attributeNameCheck)) {
      CUSTOM_ELEMENT_HANDLING.attributeNameCheck = cfg.CUSTOM_ELEMENT_HANDLING.attributeNameCheck;
    }
    if (cfg.CUSTOM_ELEMENT_HANDLING && typeof cfg.CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements === 'boolean') {
      CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements = cfg.CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements;
    }
    if (SAFE_FOR_TEMPLATES) {
      ALLOW_DATA_ATTR = false;
    }
    if (RETURN_DOM_FRAGMENT) {
      RETURN_DOM = true;
    }
    /* Parse profile info */
    if (USE_PROFILES) {
      ALLOWED_TAGS = addToSet({}, text);
      ALLOWED_ATTR = [];
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
    /* Merge configuration parameters */
    if (cfg.ADD_TAGS) {
      if (typeof cfg.ADD_TAGS === 'function') {
        EXTRA_ELEMENT_HANDLING.tagCheck = cfg.ADD_TAGS;
      } else {
        if (ALLOWED_TAGS === DEFAULT_ALLOWED_TAGS) {
          ALLOWED_TAGS = clone(ALLOWED_TAGS);
        }
        addToSet(ALLOWED_TAGS, cfg.ADD_TAGS, transformCaseFunc);
      }
    }
    if (cfg.ADD_ATTR) {
      if (typeof cfg.ADD_ATTR === 'function') {
        EXTRA_ELEMENT_HANDLING.attributeCheck = cfg.ADD_ATTR;
      } else {
        if (ALLOWED_ATTR === DEFAULT_ALLOWED_ATTR) {
          ALLOWED_ATTR = clone(ALLOWED_ATTR);
        }
        addToSet(ALLOWED_ATTR, cfg.ADD_ATTR, transformCaseFunc);
      }
    }
    if (cfg.ADD_URI_SAFE_ATTR) {
      addToSet(URI_SAFE_ATTRIBUTES, cfg.ADD_URI_SAFE_ATTR, transformCaseFunc);
    }
    if (cfg.FORBID_CONTENTS) {
      if (FORBID_CONTENTS === DEFAULT_FORBID_CONTENTS) {
        FORBID_CONTENTS = clone(FORBID_CONTENTS);
      }
      addToSet(FORBID_CONTENTS, cfg.FORBID_CONTENTS, transformCaseFunc);
    }
    if (cfg.ADD_FORBID_CONTENTS) {
      if (FORBID_CONTENTS === DEFAULT_FORBID_CONTENTS) {
        FORBID_CONTENTS = clone(FORBID_CONTENTS);
      }
      addToSet(FORBID_CONTENTS, cfg.ADD_FORBID_CONTENTS, transformCaseFunc);
    }
    /* Add #text in case KEEP_CONTENT is set to true */
    if (KEEP_CONTENT) {
      ALLOWED_TAGS['#text'] = true;
    }
    /* Add html, head and body to ALLOWED_TAGS in case WHOLE_DOCUMENT is true */
    if (WHOLE_DOCUMENT) {
      addToSet(ALLOWED_TAGS, ['html', 'head', 'body']);
    }
    /* Add tbody to ALLOWED_TAGS in case tables are permitted, see #286, #365 */
    if (ALLOWED_TAGS.table) {
      addToSet(ALLOWED_TAGS, ['tbody']);
      delete FORBID_TAGS.tbody;
    }
    if (cfg.TRUSTED_TYPES_POLICY) {
      if (typeof cfg.TRUSTED_TYPES_POLICY.createHTML !== 'function') {
        throw typeErrorCreate('TRUSTED_TYPES_POLICY configuration option must provide a "createHTML" hook.');
      }
      if (typeof cfg.TRUSTED_TYPES_POLICY.createScriptURL !== 'function') {
        throw typeErrorCreate('TRUSTED_TYPES_POLICY configuration option must provide a "createScriptURL" hook.');
      }
      // Overwrite existing TrustedTypes policy.
      trustedTypesPolicy = cfg.TRUSTED_TYPES_POLICY;
      // Sign local variables required by `sanitize`.
      emptyHTML = trustedTypesPolicy.createHTML('');
    } else {
      // Uninitialized policy, attempt to initialize the internal dompurify policy.
      if (trustedTypesPolicy === undefined) {
        trustedTypesPolicy = _createTrustedTypesPolicy(trustedTypes, currentScript);
      }
      // If creating the internal policy succeeded sign internal variables.
      if (trustedTypesPolicy !== null && typeof emptyHTML === 'string') {
        emptyHTML = trustedTypesPolicy.createHTML('');
      }
    }
    // Prevent further manipulation of configuration.
    // Not available in IE8, Safari 5, etc.
    if (freeze) {
      freeze(cfg);
    }
    CONFIG = cfg;
  };
  /* Keep track of all possible SVG and MathML tags
   * so that we can perform the namespace checks
   * correctly. */
  const ALL_SVG_TAGS = addToSet({}, [...svg$1, ...svgFilters, ...svgDisallowed]);
  const ALL_MATHML_TAGS = addToSet({}, [...mathMl$1, ...mathMlDisallowed]);
  /**
   * @param element a DOM element whose namespace is being checked
   * @returns Return false if the element has a
   *  namespace that a spec-compliant parser would never
   *  return. Return true otherwise.
   */
  const _checkValidNamespace = function _checkValidNamespace(element) {
    let parent = getParentNode(element);
    // In JSDOM, if we're inside shadow DOM, then parentNode
    // can be null. We just simulate parent in this case.
    if (!parent || !parent.tagName) {
      parent = {
        namespaceURI: NAMESPACE,
        tagName: 'template'
      };
    }
    const tagName = stringToLowerCase(element.tagName);
    const parentTagName = stringToLowerCase(parent.tagName);
    if (!ALLOWED_NAMESPACES[element.namespaceURI]) {
      return false;
    }
    if (element.namespaceURI === SVG_NAMESPACE) {
      // The only way to switch from HTML namespace to SVG
      // is via <svg>. If it happens via any other tag, then
      // it should be killed.
      if (parent.namespaceURI === HTML_NAMESPACE) {
        return tagName === 'svg';
      }
      // The only way to switch from MathML to SVG is via`
      // svg if parent is either <annotation-xml> or MathML
      // text integration points.
      if (parent.namespaceURI === MATHML_NAMESPACE) {
        return tagName === 'svg' && (parentTagName === 'annotation-xml' || MATHML_TEXT_INTEGRATION_POINTS[parentTagName]);
      }
      // We only allow elements that are defined in SVG
      // spec. All others are disallowed in SVG namespace.
      return Boolean(ALL_SVG_TAGS[tagName]);
    }
    if (element.namespaceURI === MATHML_NAMESPACE) {
      // The only way to switch from HTML namespace to MathML
      // is via <math>. If it happens via any other tag, then
      // it should be killed.
      if (parent.namespaceURI === HTML_NAMESPACE) {
        return tagName === 'math';
      }
      // The only way to switch from SVG to MathML is via
      // <math> and HTML integration points
      if (parent.namespaceURI === SVG_NAMESPACE) {
        return tagName === 'math' && HTML_INTEGRATION_POINTS[parentTagName];
      }
      // We only allow elements that are defined in MathML
      // spec. All others are disallowed in MathML namespace.
      return Boolean(ALL_MATHML_TAGS[tagName]);
    }
    if (element.namespaceURI === HTML_NAMESPACE) {
      // The only way to switch from SVG to HTML is via
      // HTML integration points, and from MathML to HTML
      // is via MathML text integration points
      if (parent.namespaceURI === SVG_NAMESPACE && !HTML_INTEGRATION_POINTS[parentTagName]) {
        return false;
      }
      if (parent.namespaceURI === MATHML_NAMESPACE && !MATHML_TEXT_INTEGRATION_POINTS[parentTagName]) {
        return false;
      }
      // We disallow tags that are specific for MathML
      // or SVG and should never appear in HTML namespace
      return !ALL_MATHML_TAGS[tagName] && (COMMON_SVG_AND_HTML_ELEMENTS[tagName] || !ALL_SVG_TAGS[tagName]);
    }
    // For XHTML and XML documents that support custom namespaces
    if (PARSER_MEDIA_TYPE === 'application/xhtml+xml' && ALLOWED_NAMESPACES[element.namespaceURI]) {
      return true;
    }
    // The code should never reach this place (this means
    // that the element somehow got namespace that is not
    // HTML, SVG, MathML or allowed via ALLOWED_NAMESPACES).
    // Return false just in case.
    return false;
  };
  /**
   * _forceRemove
   *
   * @param node a DOM node
   */
  const _forceRemove = function _forceRemove(node) {
    arrayPush(DOMPurify.removed, {
      element: node
    });
    try {
      // eslint-disable-next-line unicorn/prefer-dom-node-remove
      getParentNode(node).removeChild(node);
    } catch (_) {
      remove(node);
    }
  };
  /**
   * _removeAttribute
   *
   * @param name an Attribute name
   * @param element a DOM node
   */
  const _removeAttribute = function _removeAttribute(name, element) {
    try {
      arrayPush(DOMPurify.removed, {
        attribute: element.getAttributeNode(name),
        from: element
      });
    } catch (_) {
      arrayPush(DOMPurify.removed, {
        attribute: null,
        from: element
      });
    }
    element.removeAttribute(name);
    // We void attribute values for unremovable "is" attributes
    if (name === 'is') {
      if (RETURN_DOM || RETURN_DOM_FRAGMENT) {
        try {
          _forceRemove(element);
        } catch (_) {}
      } else {
        try {
          element.setAttribute(name, '');
        } catch (_) {}
      }
    }
  };
  /**
   * _initDocument
   *
   * @param dirty - a string of dirty markup
   * @return a DOM, filled with the dirty markup
   */
  const _initDocument = function _initDocument(dirty) {
    /* Create a HTML document */
    let doc = null;
    let leadingWhitespace = null;
    if (FORCE_BODY) {
      dirty = '<remove></remove>' + dirty;
    } else {
      /* If FORCE_BODY isn't used, leading whitespace needs to be preserved manually */
      const matches = stringMatch(dirty, /^[\r\n\t ]+/);
      leadingWhitespace = matches && matches[0];
    }
    if (PARSER_MEDIA_TYPE === 'application/xhtml+xml' && NAMESPACE === HTML_NAMESPACE) {
      // Root of XHTML doc must contain xmlns declaration (see https://www.w3.org/TR/xhtml1/normative.html#strict)
      dirty = '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>' + dirty + '</body></html>';
    }
    const dirtyPayload = trustedTypesPolicy ? trustedTypesPolicy.createHTML(dirty) : dirty;
    /*
     * Use the DOMParser API by default, fallback later if needs be
     * DOMParser not work for svg when has multiple root element.
     */
    if (NAMESPACE === HTML_NAMESPACE) {
      try {
        doc = new DOMParser().parseFromString(dirtyPayload, PARSER_MEDIA_TYPE);
      } catch (_) {}
    }
    /* Use createHTMLDocument in case DOMParser is not available */
    if (!doc || !doc.documentElement) {
      doc = implementation.createDocument(NAMESPACE, 'template', null);
      try {
        doc.documentElement.innerHTML = IS_EMPTY_INPUT ? emptyHTML : dirtyPayload;
      } catch (_) {
        // Syntax error if dirtyPayload is invalid xml
      }
    }
    const body = doc.body || doc.documentElement;
    if (dirty && leadingWhitespace) {
      body.insertBefore(document.createTextNode(leadingWhitespace), body.childNodes[0] || null);
    }
    /* Work on whole document or just its body */
    if (NAMESPACE === HTML_NAMESPACE) {
      return getElementsByTagName.call(doc, WHOLE_DOCUMENT ? 'html' : 'body')[0];
    }
    return WHOLE_DOCUMENT ? doc.documentElement : body;
  };
  /**
   * Creates a NodeIterator object that you can use to traverse filtered lists of nodes or elements in a document.
   *
   * @param root The root element or node to start traversing on.
   * @return The created NodeIterator
   */
  const _createNodeIterator = function _createNodeIterator(root) {
    return createNodeIterator.call(root.ownerDocument || root, root,
    // eslint-disable-next-line no-bitwise
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_PROCESSING_INSTRUCTION | NodeFilter.SHOW_CDATA_SECTION, null);
  };
  /**
   * _isClobbered
   *
   * @param element element to check for clobbering attacks
   * @return true if clobbered, false if safe
   */
  const _isClobbered = function _isClobbered(element) {
    return element instanceof HTMLFormElement && (typeof element.nodeName !== 'string' || typeof element.textContent !== 'string' || typeof element.removeChild !== 'function' || !(element.attributes instanceof NamedNodeMap) || typeof element.removeAttribute !== 'function' || typeof element.setAttribute !== 'function' || typeof element.namespaceURI !== 'string' || typeof element.insertBefore !== 'function' || typeof element.hasChildNodes !== 'function');
  };
  /**
   * Checks whether the given object is a DOM node.
   *
   * @param value object to check whether it's a DOM node
   * @return true is object is a DOM node
   */
  const _isNode = function _isNode(value) {
    return typeof Node === 'function' && value instanceof Node;
  };
  function _executeHooks(hooks, currentNode, data) {
    arrayForEach(hooks, hook => {
      hook.call(DOMPurify, currentNode, data, CONFIG);
    });
  }
  /**
   * _sanitizeElements
   *
   * @protect nodeName
   * @protect textContent
   * @protect removeChild
   * @param currentNode to check for permission to exist
   * @return true if node was killed, false if left alive
   */
  const _sanitizeElements = function _sanitizeElements(currentNode) {
    let content = null;
    /* Execute a hook if present */
    _executeHooks(hooks.beforeSanitizeElements, currentNode, null);
    /* Check if element is clobbered or can clobber */
    if (_isClobbered(currentNode)) {
      _forceRemove(currentNode);
      return true;
    }
    /* Now let's check the element's type and name */
    const tagName = transformCaseFunc(currentNode.nodeName);
    /* Execute a hook if present */
    _executeHooks(hooks.uponSanitizeElement, currentNode, {
      tagName,
      allowedTags: ALLOWED_TAGS
    });
    /* Detect mXSS attempts abusing namespace confusion */
    if (SAFE_FOR_XML && currentNode.hasChildNodes() && !_isNode(currentNode.firstElementChild) && regExpTest(/<[/\w!]/g, currentNode.innerHTML) && regExpTest(/<[/\w!]/g, currentNode.textContent)) {
      _forceRemove(currentNode);
      return true;
    }
    /* Remove any occurrence of processing instructions */
    if (currentNode.nodeType === NODE_TYPE.progressingInstruction) {
      _forceRemove(currentNode);
      return true;
    }
    /* Remove any kind of possibly harmful comments */
    if (SAFE_FOR_XML && currentNode.nodeType === NODE_TYPE.comment && regExpTest(/<[/\w]/g, currentNode.data)) {
      _forceRemove(currentNode);
      return true;
    }
    /* Remove element if anything forbids its presence */
    if (!(EXTRA_ELEMENT_HANDLING.tagCheck instanceof Function && EXTRA_ELEMENT_HANDLING.tagCheck(tagName)) && (!ALLOWED_TAGS[tagName] || FORBID_TAGS[tagName])) {
      /* Check if we have a custom element to handle */
      if (!FORBID_TAGS[tagName] && _isBasicCustomElement(tagName)) {
        if (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof RegExp && regExpTest(CUSTOM_ELEMENT_HANDLING.tagNameCheck, tagName)) {
          return false;
        }
        if (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof Function && CUSTOM_ELEMENT_HANDLING.tagNameCheck(tagName)) {
          return false;
        }
      }
      /* Keep content except for bad-listed elements */
      if (KEEP_CONTENT && !FORBID_CONTENTS[tagName]) {
        const parentNode = getParentNode(currentNode) || currentNode.parentNode;
        const childNodes = getChildNodes(currentNode) || currentNode.childNodes;
        if (childNodes && parentNode) {
          const childCount = childNodes.length;
          for (let i = childCount - 1; i >= 0; --i) {
            const childClone = cloneNode(childNodes[i], true);
            childClone.__removalCount = (currentNode.__removalCount || 0) + 1;
            parentNode.insertBefore(childClone, getNextSibling(currentNode));
          }
        }
      }
      _forceRemove(currentNode);
      return true;
    }
    /* Check whether element has a valid namespace */
    if (currentNode instanceof Element && !_checkValidNamespace(currentNode)) {
      _forceRemove(currentNode);
      return true;
    }
    /* Make sure that older browsers don't get fallback-tag mXSS */
    if ((tagName === 'noscript' || tagName === 'noembed' || tagName === 'noframes') && regExpTest(/<\/no(script|embed|frames)/i, currentNode.innerHTML)) {
      _forceRemove(currentNode);
      return true;
    }
    /* Sanitize element content to be template-safe */
    if (SAFE_FOR_TEMPLATES && currentNode.nodeType === NODE_TYPE.text) {
      /* Get the element's text content */
      content = currentNode.textContent;
      arrayForEach([MUSTACHE_EXPR, ERB_EXPR, TMPLIT_EXPR], expr => {
        content = stringReplace(content, expr, ' ');
      });
      if (currentNode.textContent !== content) {
        arrayPush(DOMPurify.removed, {
          element: currentNode.cloneNode()
        });
        currentNode.textContent = content;
      }
    }
    /* Execute a hook if present */
    _executeHooks(hooks.afterSanitizeElements, currentNode, null);
    return false;
  };
  /**
   * _isValidAttribute
   *
   * @param lcTag Lowercase tag name of containing element.
   * @param lcName Lowercase attribute name.
   * @param value Attribute value.
   * @return Returns true if `value` is valid, otherwise false.
   */
  // eslint-disable-next-line complexity
  const _isValidAttribute = function _isValidAttribute(lcTag, lcName, value) {
    /* Make sure attribute cannot clobber */
    if (SANITIZE_DOM && (lcName === 'id' || lcName === 'name') && (value in document || value in formElement)) {
      return false;
    }
    /* Allow valid data-* attributes: At least one character after "-"
        (https://html.spec.whatwg.org/multipage/dom.html#embedding-custom-non-visible-data-with-the-data-*-attributes)
        XML-compatible (https://html.spec.whatwg.org/multipage/infrastructure.html#xml-compatible and http://www.w3.org/TR/xml/#d0e804)
        We don't need to check the value; it's always URI safe. */
    if (ALLOW_DATA_ATTR && !FORBID_ATTR[lcName] && regExpTest(DATA_ATTR, lcName)) ; else if (ALLOW_ARIA_ATTR && regExpTest(ARIA_ATTR, lcName)) ; else if (EXTRA_ELEMENT_HANDLING.attributeCheck instanceof Function && EXTRA_ELEMENT_HANDLING.attributeCheck(lcName, lcTag)) ; else if (!ALLOWED_ATTR[lcName] || FORBID_ATTR[lcName]) {
      if (
      // First condition does a very basic check if a) it's basically a valid custom element tagname AND
      // b) if the tagName passes whatever the user has configured for CUSTOM_ELEMENT_HANDLING.tagNameCheck
      // and c) if the attribute name passes whatever the user has configured for CUSTOM_ELEMENT_HANDLING.attributeNameCheck
      _isBasicCustomElement(lcTag) && (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof RegExp && regExpTest(CUSTOM_ELEMENT_HANDLING.tagNameCheck, lcTag) || CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof Function && CUSTOM_ELEMENT_HANDLING.tagNameCheck(lcTag)) && (CUSTOM_ELEMENT_HANDLING.attributeNameCheck instanceof RegExp && regExpTest(CUSTOM_ELEMENT_HANDLING.attributeNameCheck, lcName) || CUSTOM_ELEMENT_HANDLING.attributeNameCheck instanceof Function && CUSTOM_ELEMENT_HANDLING.attributeNameCheck(lcName, lcTag)) ||
      // Alternative, second condition checks if it's an `is`-attribute, AND
      // the value passes whatever the user has configured for CUSTOM_ELEMENT_HANDLING.tagNameCheck
      lcName === 'is' && CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements && (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof RegExp && regExpTest(CUSTOM_ELEMENT_HANDLING.tagNameCheck, value) || CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof Function && CUSTOM_ELEMENT_HANDLING.tagNameCheck(value))) ; else {
        return false;
      }
      /* Check value is safe. First, is attr inert? If so, is safe */
    } else if (URI_SAFE_ATTRIBUTES[lcName]) ; else if (regExpTest(IS_ALLOWED_URI$1, stringReplace(value, ATTR_WHITESPACE, ''))) ; else if ((lcName === 'src' || lcName === 'xlink:href' || lcName === 'href') && lcTag !== 'script' && stringIndexOf(value, 'data:') === 0 && DATA_URI_TAGS[lcTag]) ; else if (ALLOW_UNKNOWN_PROTOCOLS && !regExpTest(IS_SCRIPT_OR_DATA, stringReplace(value, ATTR_WHITESPACE, ''))) ; else if (value) {
      return false;
    } else ;
    return true;
  };
  /**
   * _isBasicCustomElement
   * checks if at least one dash is included in tagName, and it's not the first char
   * for more sophisticated checking see https://github.com/sindresorhus/validate-element-name
   *
   * @param tagName name of the tag of the node to sanitize
   * @returns Returns true if the tag name meets the basic criteria for a custom element, otherwise false.
   */
  const _isBasicCustomElement = function _isBasicCustomElement(tagName) {
    return tagName !== 'annotation-xml' && stringMatch(tagName, CUSTOM_ELEMENT);
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
   */
  const _sanitizeAttributes = function _sanitizeAttributes(currentNode) {
    /* Execute a hook if present */
    _executeHooks(hooks.beforeSanitizeAttributes, currentNode, null);
    const {
      attributes
    } = currentNode;
    /* Check if we have attributes; if not we might have a text node */
    if (!attributes || _isClobbered(currentNode)) {
      return;
    }
    const hookEvent = {
      attrName: '',
      attrValue: '',
      keepAttr: true,
      allowedAttributes: ALLOWED_ATTR,
      forceKeepAttr: undefined
    };
    let l = attributes.length;
    /* Go backwards over all attributes; safely remove bad ones */
    while (l--) {
      const attr = attributes[l];
      const {
        name,
        namespaceURI,
        value: attrValue
      } = attr;
      const lcName = transformCaseFunc(name);
      const initValue = attrValue;
      let value = name === 'value' ? initValue : stringTrim(initValue);
      /* Execute a hook if present */
      hookEvent.attrName = lcName;
      hookEvent.attrValue = value;
      hookEvent.keepAttr = true;
      hookEvent.forceKeepAttr = undefined; // Allows developers to see this is a property they can set
      _executeHooks(hooks.uponSanitizeAttribute, currentNode, hookEvent);
      value = hookEvent.attrValue;
      /* Full DOM Clobbering protection via namespace isolation,
       * Prefix id and name attributes with `user-content-`
       */
      if (SANITIZE_NAMED_PROPS && (lcName === 'id' || lcName === 'name')) {
        // Remove the attribute with this value
        _removeAttribute(name, currentNode);
        // Prefix the value and later re-create the attribute with the sanitized value
        value = SANITIZE_NAMED_PROPS_PREFIX + value;
      }
      /* Work around a security issue with comments inside attributes */
      if (SAFE_FOR_XML && regExpTest(/((--!?|])>)|<\/(style|title|textarea)/i, value)) {
        _removeAttribute(name, currentNode);
        continue;
      }
      /* Make sure we cannot easily use animated hrefs, even if animations are allowed */
      if (lcName === 'attributename' && stringMatch(value, 'href')) {
        _removeAttribute(name, currentNode);
        continue;
      }
      /* Did the hooks approve of the attribute? */
      if (hookEvent.forceKeepAttr) {
        continue;
      }
      /* Did the hooks approve of the attribute? */
      if (!hookEvent.keepAttr) {
        _removeAttribute(name, currentNode);
        continue;
      }
      /* Work around a security issue in jQuery 3.0 */
      if (!ALLOW_SELF_CLOSE_IN_ATTR && regExpTest(/\/>/i, value)) {
        _removeAttribute(name, currentNode);
        continue;
      }
      /* Sanitize attribute content to be template-safe */
      if (SAFE_FOR_TEMPLATES) {
        arrayForEach([MUSTACHE_EXPR, ERB_EXPR, TMPLIT_EXPR], expr => {
          value = stringReplace(value, expr, ' ');
        });
      }
      /* Is `value` valid for this attribute? */
      const lcTag = transformCaseFunc(currentNode.nodeName);
      if (!_isValidAttribute(lcTag, lcName, value)) {
        _removeAttribute(name, currentNode);
        continue;
      }
      /* Handle attributes that require Trusted Types */
      if (trustedTypesPolicy && typeof trustedTypes === 'object' && typeof trustedTypes.getAttributeType === 'function') {
        if (namespaceURI) ; else {
          switch (trustedTypes.getAttributeType(lcTag, lcName)) {
            case 'TrustedHTML':
              {
                value = trustedTypesPolicy.createHTML(value);
                break;
              }
            case 'TrustedScriptURL':
              {
                value = trustedTypesPolicy.createScriptURL(value);
                break;
              }
          }
        }
      }
      /* Handle invalid data-* attribute set by try-catching it */
      if (value !== initValue) {
        try {
          if (namespaceURI) {
            currentNode.setAttributeNS(namespaceURI, name, value);
          } else {
            /* Fallback to setAttribute() for browser-unrecognized namespaces e.g. "x-schema". */
            currentNode.setAttribute(name, value);
          }
          if (_isClobbered(currentNode)) {
            _forceRemove(currentNode);
          } else {
            arrayPop(DOMPurify.removed);
          }
        } catch (_) {
          _removeAttribute(name, currentNode);
        }
      }
    }
    /* Execute a hook if present */
    _executeHooks(hooks.afterSanitizeAttributes, currentNode, null);
  };
  /**
   * _sanitizeShadowDOM
   *
   * @param fragment to iterate over recursively
   */
  const _sanitizeShadowDOM = function _sanitizeShadowDOM(fragment) {
    let shadowNode = null;
    const shadowIterator = _createNodeIterator(fragment);
    /* Execute a hook if present */
    _executeHooks(hooks.beforeSanitizeShadowDOM, fragment, null);
    while (shadowNode = shadowIterator.nextNode()) {
      /* Execute a hook if present */
      _executeHooks(hooks.uponSanitizeShadowNode, shadowNode, null);
      /* Sanitize tags and elements */
      _sanitizeElements(shadowNode);
      /* Check attributes next */
      _sanitizeAttributes(shadowNode);
      /* Deep shadow DOM detected */
      if (shadowNode.content instanceof DocumentFragment) {
        _sanitizeShadowDOM(shadowNode.content);
      }
    }
    /* Execute a hook if present */
    _executeHooks(hooks.afterSanitizeShadowDOM, fragment, null);
  };
  // eslint-disable-next-line complexity
  DOMPurify.sanitize = function (dirty) {
    let cfg = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
    let body = null;
    let importedNode = null;
    let currentNode = null;
    let returnNode = null;
    /* Make sure we have a string to sanitize.
      DO NOT return early, as this will return the wrong type if
      the user has requested a DOM object rather than a string */
    IS_EMPTY_INPUT = !dirty;
    if (IS_EMPTY_INPUT) {
      dirty = '<!-->';
    }
    /* Stringify, in case dirty is an object */
    if (typeof dirty !== 'string' && !_isNode(dirty)) {
      if (typeof dirty.toString === 'function') {
        dirty = dirty.toString();
        if (typeof dirty !== 'string') {
          throw typeErrorCreate('dirty is not a string, aborting');
        }
      } else {
        throw typeErrorCreate('toString is not a function');
      }
    }
    /* Return dirty HTML if DOMPurify cannot run */
    if (!DOMPurify.isSupported) {
      return dirty;
    }
    /* Assign config vars */
    if (!SET_CONFIG) {
      _parseConfig(cfg);
    }
    /* Clean up removed elements */
    DOMPurify.removed = [];
    /* Check if dirty is correctly typed for IN_PLACE */
    if (typeof dirty === 'string') {
      IN_PLACE = false;
    }
    if (IN_PLACE) {
      /* Do some early pre-sanitization to avoid unsafe root nodes */
      if (dirty.nodeName) {
        const tagName = transformCaseFunc(dirty.nodeName);
        if (!ALLOWED_TAGS[tagName] || FORBID_TAGS[tagName]) {
          throw typeErrorCreate('root node is forbidden and cannot be sanitized in-place');
        }
      }
    } else if (dirty instanceof Node) {
      /* If dirty is a DOM element, append to an empty document to avoid
         elements being stripped by the parser */
      body = _initDocument('<!---->');
      importedNode = body.ownerDocument.importNode(dirty, true);
      if (importedNode.nodeType === NODE_TYPE.element && importedNode.nodeName === 'BODY') {
        /* Node is already a body, use as is */
        body = importedNode;
      } else if (importedNode.nodeName === 'HTML') {
        body = importedNode;
      } else {
        // eslint-disable-next-line unicorn/prefer-dom-node-append
        body.appendChild(importedNode);
      }
    } else {
      /* Exit directly if we have nothing to do */
      if (!RETURN_DOM && !SAFE_FOR_TEMPLATES && !WHOLE_DOCUMENT &&
      // eslint-disable-next-line unicorn/prefer-includes
      dirty.indexOf('<') === -1) {
        return trustedTypesPolicy && RETURN_TRUSTED_TYPE ? trustedTypesPolicy.createHTML(dirty) : dirty;
      }
      /* Initialize the document to work on */
      body = _initDocument(dirty);
      /* Check we have a DOM node from the data */
      if (!body) {
        return RETURN_DOM ? null : RETURN_TRUSTED_TYPE ? emptyHTML : '';
      }
    }
    /* Remove first element node (ours) if FORCE_BODY is set */
    if (body && FORCE_BODY) {
      _forceRemove(body.firstChild);
    }
    /* Get node iterator */
    const nodeIterator = _createNodeIterator(IN_PLACE ? dirty : body);
    /* Now start iterating over the created document */
    while (currentNode = nodeIterator.nextNode()) {
      /* Sanitize tags and elements */
      _sanitizeElements(currentNode);
      /* Check attributes next */
      _sanitizeAttributes(currentNode);
      /* Shadow DOM detected, sanitize it */
      if (currentNode.content instanceof DocumentFragment) {
        _sanitizeShadowDOM(currentNode.content);
      }
    }
    /* If we sanitized `dirty` in-place, return it. */
    if (IN_PLACE) {
      return dirty;
    }
    /* Return sanitized string or DOM */
    if (RETURN_DOM) {
      if (RETURN_DOM_FRAGMENT) {
        returnNode = createDocumentFragment.call(body.ownerDocument);
        while (body.firstChild) {
          // eslint-disable-next-line unicorn/prefer-dom-node-append
          returnNode.appendChild(body.firstChild);
        }
      } else {
        returnNode = body;
      }
      if (ALLOWED_ATTR.shadowroot || ALLOWED_ATTR.shadowrootmode) {
        /*
          AdoptNode() is not used because internal state is not reset
          (e.g. the past names map of a HTMLFormElement), this is safe
          in theory but we would rather not risk another attack vector.
          The state that is cloned by importNode() is explicitly defined
          by the specs.
        */
        returnNode = importNode.call(originalDocument, returnNode, true);
      }
      return returnNode;
    }
    let serializedHTML = WHOLE_DOCUMENT ? body.outerHTML : body.innerHTML;
    /* Serialize doctype if allowed */
    if (WHOLE_DOCUMENT && ALLOWED_TAGS['!doctype'] && body.ownerDocument && body.ownerDocument.doctype && body.ownerDocument.doctype.name && regExpTest(DOCTYPE_NAME, body.ownerDocument.doctype.name)) {
      serializedHTML = '<!DOCTYPE ' + body.ownerDocument.doctype.name + '>\n' + serializedHTML;
    }
    /* Sanitize final string template-safe */
    if (SAFE_FOR_TEMPLATES) {
      arrayForEach([MUSTACHE_EXPR, ERB_EXPR, TMPLIT_EXPR], expr => {
        serializedHTML = stringReplace(serializedHTML, expr, ' ');
      });
    }
    return trustedTypesPolicy && RETURN_TRUSTED_TYPE ? trustedTypesPolicy.createHTML(serializedHTML) : serializedHTML;
  };
  DOMPurify.setConfig = function () {
    let cfg = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    _parseConfig(cfg);
    SET_CONFIG = true;
  };
  DOMPurify.clearConfig = function () {
    CONFIG = null;
    SET_CONFIG = false;
  };
  DOMPurify.isValidAttribute = function (tag, attr, value) {
    /* Initialize shared config vars if necessary. */
    if (!CONFIG) {
      _parseConfig({});
    }
    const lcTag = transformCaseFunc(tag);
    const lcName = transformCaseFunc(attr);
    return _isValidAttribute(lcTag, lcName, value);
  };
  DOMPurify.addHook = function (entryPoint, hookFunction) {
    if (typeof hookFunction !== 'function') {
      return;
    }
    arrayPush(hooks[entryPoint], hookFunction);
  };
  DOMPurify.removeHook = function (entryPoint, hookFunction) {
    if (hookFunction !== undefined) {
      const index = arrayLastIndexOf(hooks[entryPoint], hookFunction);
      return index === -1 ? undefined : arraySplice(hooks[entryPoint], index, 1)[0];
    }
    return arrayPop(hooks[entryPoint]);
  };
  DOMPurify.removeHooks = function (entryPoint) {
    hooks[entryPoint] = [];
  };
  DOMPurify.removeAllHooks = function () {
    hooks = _createHooksMap();
  };
  return DOMPurify;
}
var purify = createDOMPurify();

function sanitizeHtml(html) {
    return purify.sanitize(html, {
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
            // Other
            'hr', 'sub', 'sup', 'small', 'mark', 'abbr', 'cite', 'time'
        ],
        ALLOWED_ATTR: ['href', 'target', 'rel', 'title', 'class', 'id', 'style'],
        ALLOW_DATA_ATTR: false,
        // Allow style attribute but sanitize it
        ALLOW_UNKNOWN_PROTOCOLS: false,
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
    const [isVisible, setIsVisible] = useState(false);
    useEffect(() => {
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
    return (React.createElement("div", { className: `journy-message-overlay ${isVisible ? 'journy-message-visible' : ''}` },
        React.createElement("div", { className: `journy-message-popup journy-message-${messageType}` },
            React.createElement("button", { className: "journy-message-close", onClick: onClose, "aria-label": "Close message" }, "\u00D7"),
            message.createdAt && (React.createElement("div", { className: "journy-message-timestamp" }, formatTimestamp(message.createdAt))),
            React.createElement("div", { className: "journy-message-content", dangerouslySetInnerHTML: { __html: sanitizedContent }, onClick: (e) => {
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
    const [showAdvanced, setShowAdvanced] = useState(false);
    const update = (partial) => {
        onSettingsChange({ ...settings, ...partial });
    };
    const handleToggle = (key) => {
        update({ [key]: !settings[key] });
    };
    const stylesKey = getStylesKey(settings.styles);
    return (React.createElement("div", { className: `journy-settings-panel ${isOpen ? 'journy-settings-panel-open' : 'journy-settings-panel-closed'}`, onClick: (e) => e.stopPropagation() },
        React.createElement("div", { className: "journy-settings-header" },
            React.createElement("span", { className: "journy-settings-title" }, "Settings"),
            React.createElement("button", { type: "button", className: "journy-settings-close", onClick: onClose, title: "Close settings", "aria-label": "Close settings" }, "\u00D7")),
        React.createElement("div", { className: "journy-settings-body" },
            React.createElement("div", { className: "journy-settings-item" },
                React.createElement("label", { className: "journy-settings-label" }, "Display mode"),
                React.createElement("select", { className: "journy-settings-select", value: settings.displayMode, onChange: (e) => update({ displayMode: e.target.value }) }, DISPLAY_MODE_OPTIONS.map((opt) => (React.createElement("option", { key: opt.value, value: opt.value }, opt.label))))),
            React.createElement("div", { className: "journy-settings-item" },
                React.createElement("label", { className: "journy-settings-label" }, "Polling interval"),
                React.createElement("select", { className: "journy-settings-select", value: settings.pollingInterval, onChange: (e) => update({ pollingInterval: Number(e.target.value) }) }, POLLING_OPTIONS.map((opt) => (React.createElement("option", { key: opt.value, value: opt.value }, opt.label))))),
            React.createElement("div", { className: "journy-settings-item" },
                React.createElement("label", { className: "journy-settings-label" }, "Show read messages"),
                React.createElement("button", { type: "button", className: `journy-settings-toggle ${settings.showReadMessages ? 'journy-settings-toggle-on' : ''}`, onClick: () => handleToggle('showReadMessages'), role: "switch", "aria-checked": settings.showReadMessages },
                    React.createElement("span", { className: "journy-settings-toggle-knob" }))),
            React.createElement("div", { className: "journy-settings-item" },
                React.createElement("label", { className: "journy-settings-label" }, "Auto-expand on new messages"),
                React.createElement("button", { type: "button", className: `journy-settings-toggle ${settings.autoExpandOnNew ? 'journy-settings-toggle-on' : ''}`, onClick: () => handleToggle('autoExpandOnNew'), role: "switch", "aria-checked": settings.autoExpandOnNew },
                    React.createElement("span", { className: "journy-settings-toggle-knob" }))),
            React.createElement("div", { className: "journy-settings-item" },
                React.createElement("label", { className: "journy-settings-label" }, "Styles"),
                React.createElement("select", { className: "journy-settings-select", value: stylesKey, onChange: (e) => {
                        const val = e.target.value;
                        if (val === 'default' || val === 'none') {
                            update({ styles: val });
                        }
                    } },
                    STYLES_OPTIONS.map((opt) => (React.createElement("option", { key: opt.value, value: opt.value }, opt.label))),
                    stylesKey === 'custom-url' && (React.createElement("option", { value: "custom-url", disabled: true }, "Custom URL")),
                    stylesKey === 'custom-css' && (React.createElement("option", { value: "custom-css", disabled: true }, "Custom CSS")))),
            React.createElement("div", { className: "journy-settings-item" },
                React.createElement("button", { type: "button", className: "journy-settings-advanced-btn", onClick: () => setShowAdvanced(!showAdvanced) }, showAdvanced ? '▾ Advanced' : '▸ Advanced')),
            showAdvanced && (React.createElement(React.Fragment, null,
                React.createElement("div", { className: "journy-settings-item journy-settings-item-vertical" },
                    React.createElement("label", { className: "journy-settings-label" }, "API endpoint"),
                    React.createElement("input", { type: "text", className: "journy-settings-input", value: settings.apiEndpoint, onChange: (e) => update({ apiEndpoint: e.target.value }), placeholder: "https://jtm.journy.io" })),
                configInfo && (React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "journy-settings-item" },
                        React.createElement("label", { className: "journy-settings-label" }, "Entity type"),
                        React.createElement("span", { className: "journy-settings-value" }, configInfo.entityType)),
                    configInfo.userId && (React.createElement("div", { className: "journy-settings-item" },
                        React.createElement("label", { className: "journy-settings-label" }, "User ID"),
                        React.createElement("span", { className: "journy-settings-value" }, configInfo.userId))),
                    configInfo.accountId && (React.createElement("div", { className: "journy-settings-item" },
                        React.createElement("label", { className: "journy-settings-label" }, "Account ID"),
                        React.createElement("span", { className: "journy-settings-value" }, configInfo.accountId))))))))));
};

const ICON_SIZE$1 = 12;
const DOT_FIRST = 2;
const DOT_SECOND = 6;
const DOT_THIRD = 10;
const DOT_RADIUS = 1;
const DragHandle = ({ onMouseDown, title = 'Drag to move', className = 'journy-message-widget-drag-handle', }) => (React.createElement("div", { className: className, onMouseDown: onMouseDown, title: title },
    React.createElement("svg", { width: ICON_SIZE$1, height: ICON_SIZE$1, viewBox: `0 0 ${ICON_SIZE$1} ${ICON_SIZE$1}`, fill: "none", xmlns: "http://www.w3.org/2000/svg" },
        React.createElement("circle", { cx: DOT_FIRST, cy: DOT_FIRST, r: DOT_RADIUS, fill: "#9ca3af" }),
        React.createElement("circle", { cx: DOT_SECOND, cy: DOT_FIRST, r: DOT_RADIUS, fill: "#9ca3af" }),
        React.createElement("circle", { cx: DOT_THIRD, cy: DOT_FIRST, r: DOT_RADIUS, fill: "#9ca3af" }),
        React.createElement("circle", { cx: DOT_FIRST, cy: DOT_SECOND, r: DOT_RADIUS, fill: "#9ca3af" }),
        React.createElement("circle", { cx: DOT_SECOND, cy: DOT_SECOND, r: DOT_RADIUS, fill: "#9ca3af" }),
        React.createElement("circle", { cx: DOT_THIRD, cy: DOT_SECOND, r: DOT_RADIUS, fill: "#9ca3af" }),
        React.createElement("circle", { cx: DOT_FIRST, cy: DOT_THIRD, r: DOT_RADIUS, fill: "#9ca3af" }),
        React.createElement("circle", { cx: DOT_SECOND, cy: DOT_THIRD, r: DOT_RADIUS, fill: "#9ca3af" }),
        React.createElement("circle", { cx: DOT_THIRD, cy: DOT_THIRD, r: DOT_RADIUS, fill: "#9ca3af" }))));

const ICON_SIZE = 16;
const STROKE_WIDTH = 1.5;
/** Diagonal from top-right to bottom-left (resize corner). */
const PATH_MAIN = 'M16 0 L0 16';
const PATH_INNER = 'M13 3 L3 13';
const ResizeHandle = ({ onMouseDown, title = 'Resize', className = 'journy-message-widget-resize-handle', }) => (React.createElement("div", { className: className, onMouseDown: onMouseDown, title: title },
    React.createElement("svg", { width: ICON_SIZE, height: ICON_SIZE, viewBox: `0 0 ${ICON_SIZE} ${ICON_SIZE}`, fill: "none", xmlns: "http://www.w3.org/2000/svg" },
        React.createElement("path", { d: `${PATH_MAIN} ${PATH_INNER}`, stroke: "#9ca3af", strokeWidth: STROKE_WIDTH, strokeLinecap: "round" }))));

const COLLAPSED_WIDTH = 300;
const COLLAPSED_HEIGHT = 80;
const WIDGET_MODE_EXPANDED_WIDTH = 340;
const WIDGET_MODE_EXPANDED_HEIGHT = 280;
const LIST_MODE_DEFAULT_WIDTH = 600;
const LIST_MODE_DEFAULT_HEIGHT = 800;
const DEFAULT_EDGE_OFFSET = 20;
const VIEWPORT_PADDING = 40;
const MIN_LIST_WIDTH = 300;
const MIN_LIST_HEIGHT = 200;
const MIN_POSITION_THRESHOLD = 0;
function useWidgetDragResize({ isCollapsed, isListMode }) {
    const [position, setPosition] = useState(() => {
        const saved = getItem('widget_position');
        if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
            return {
                left: Math.max(0, Math.min(saved.left, window.innerWidth - COLLAPSED_WIDTH)),
                top: Math.max(0, Math.min(saved.top, window.innerHeight - COLLAPSED_HEIGHT)),
            };
        }
        if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
            return {
                left: Math.max(0, saved.x - COLLAPSED_WIDTH),
                top: Math.max(0, saved.y - COLLAPSED_HEIGHT),
            };
        }
        return {
            left: window.innerWidth - DEFAULT_EDGE_OFFSET - COLLAPSED_WIDTH,
            top: window.innerHeight - DEFAULT_EDGE_OFFSET - COLLAPSED_HEIGHT,
        };
    });
    const [size, setSize] = useState({ width: LIST_MODE_DEFAULT_WIDTH, height: LIST_MODE_DEFAULT_HEIGHT });
    const [isDragging, setIsDragging] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [resizeStart, setResizeStart] = useState(null);
    const widgetRef = useRef(null);
    const hasDraggedThisSession = useRef(false);
    const justFinishedDragging = useRef(false);
    const currentWidth = isCollapsed
        ? COLLAPSED_WIDTH
        : isListMode
            ? size.width
            : WIDGET_MODE_EXPANDED_WIDTH;
    const currentHeight = isCollapsed
        ? COLLAPSED_HEIGHT
        : isListMode
            ? size.height
            : WIDGET_MODE_EXPANDED_HEIGHT;
    // Load saved size from localStorage on mount
    useEffect(() => {
        const savedSize = getItem('widget_size');
        if (savedSize) {
            setSize({
                width: Math.max(MIN_LIST_WIDTH, Math.min(savedSize.width, window.innerWidth - VIEWPORT_PADDING)),
                height: Math.max(MIN_LIST_HEIGHT, Math.min(savedSize.height, window.innerHeight - VIEWPORT_PADDING)),
            });
        }
    }, []);
    // Clamp position so widget stays on screen
    useEffect(() => {
        setPosition(prev => ({
            left: Math.max(0, Math.min(prev.left, window.innerWidth - currentWidth)),
            top: Math.max(0, Math.min(prev.top, window.innerHeight - currentHeight)),
        }));
    }, [currentWidth, currentHeight]);
    // Save position when it changes
    useEffect(() => {
        if (position.left > MIN_POSITION_THRESHOLD || position.top > MIN_POSITION_THRESHOLD) {
            setItem('widget_position', position);
        }
    }, [position]);
    // Save size when it changes (list mode expanded only)
    useEffect(() => {
        if (isListMode && !isCollapsed && size.width > MIN_POSITION_THRESHOLD && size.height > MIN_POSITION_THRESHOLD) {
            setItem('widget_size', size);
        }
    }, [size, isCollapsed, isListMode]);
    // Constrain position when window resizes
    useEffect(() => {
        const handleResize = () => {
            setPosition(prev => ({
                left: Math.max(0, Math.min(prev.left, window.innerWidth - currentWidth)),
                top: Math.max(0, Math.min(prev.top, window.innerHeight - currentHeight)),
            }));
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [currentWidth, currentHeight]);
    const handleMouseDown = (e) => {
        const target = e.target;
        if (!target.closest('.journy-message-widget-drag-handle'))
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
    useEffect(() => {
        if (!isDragging && !isResizing)
            return;
        const handleMouseMove = (e) => {
            if (isDragging) {
                hasDraggedThisSession.current = true;
                const newLeft = e.clientX - dragOffset.x;
                const newTop = e.clientY - dragOffset.y;
                setPosition({
                    left: Math.max(0, Math.min(newLeft, window.innerWidth - currentWidth)),
                    top: Math.max(0, Math.min(newTop, window.innerHeight - currentHeight)),
                });
            }
            else if (isResizing && resizeStart) {
                const deltaX = e.clientX - resizeStart.x;
                const deltaY = e.clientY - resizeStart.y;
                const maxWidth = window.innerWidth - position.left;
                const maxHeight = window.innerHeight - position.top;
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
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, isResizing, dragOffset, resizeStart, position, currentWidth, currentHeight]);
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

const SETTINGS_STORAGE_KEY = 'widget_settings';
/** Mark message as received when its element is visible in the viewport. */
function useMessageVisibility(ref, messageId, received, onMessageReceived) {
    const hasFiredRef = useRef(false);
    useEffect(() => {
        if (received) {
            hasFiredRef.current = true;
            return;
        }
        hasFiredRef.current = false;
        const el = ref.current;
        if (!el || !onMessageReceived)
            return;
        const observer = new IntersectionObserver((entries) => {
            const [entry] = entries;
            if (entry?.isIntersecting && !hasFiredRef.current) {
                hasFiredRef.current = true;
                onMessageReceived([messageId]);
                observer.disconnect();
            }
        }, { threshold: 0.1, root: null });
        observer.observe(el);
        return () => observer.disconnect();
    }, [messageId, received, onMessageReceived]);
}
/** Wraps a message row with a ref and viewport visibility observer to mark as received when visible. */
const MessageRow = ({ message, isSeparated, onMessageReceived, onDismissMessage, children }) => {
    const ref = useRef(null);
    useMessageVisibility(ref, message.id, message.received, onMessageReceived);
    return (React.createElement("div", { ref: ref, className: `journy-message-widget-message journy-message-${message.received ? 'viewed' : 'info'} ${isSeparated ? 'journy-message-widget-message-separated' : ''}` },
        onDismissMessage && (React.createElement("button", { type: "button", className: "journy-message-widget-message-close", onClick: (e) => {
                e.stopPropagation();
                e.preventDefault();
                onDismissMessage(message.id);
            }, title: "Dismiss message", "aria-label": "Dismiss" }, "\u00D7")),
        children));
};
/** Derives total, unread, and read counts from the messages array. */
function useMessageCounts(messages) {
    return useMemo(() => {
        const unreadCount = messages.filter((m) => !m.received).length;
        const readCount = messages.filter((m) => m.received).length;
        return {
            totalCount: messages.length,
            unreadCount,
            readCount,
        };
    }, [messages]);
}
const MessageWidget = ({ store, onClose, onCloseWidget, onLinkClick, onToggleExpand, onMessageReceived, onDismissMessage, onNextMessage, onPrevMessage, onSettingsChange, configInfo, }) => {
    const { messages, currentMessage, isCollapsed, displayMode, widgetVisible } = useMessagingStore(store);
    const { totalCount, unreadCount, readCount } = useMessageCounts(messages);
    const [modalMessage, setModalMessage] = useState(null);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [settings, setSettings] = useState(() => {
        const saved = getItem(SETTINGS_STORAGE_KEY);
        return saved
            ? { ...DEFAULT_WIDGET_SETTINGS, ...saved, displayMode }
            : { ...DEFAULT_WIDGET_SETTINGS, displayMode };
    });
    const isListMode = displayMode === 'list';
    const { position, isDragging, isResizing, widgetRef, justFinishedDragging, currentWidth, currentHeight, handleMouseDown, handleResizeStart, } = useWidgetDragResize({ isCollapsed, isListMode });
    const contentRef = useRef(null);
    const scrollTimerRef = useRef(null);
    // Persist scroll position on scroll (debounced), restore on mount/expand
    useEffect(() => {
        if (isCollapsed || !isListMode)
            return;
        const el = contentRef.current;
        if (!el)
            return;
        // Restore saved scroll position
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
    const handleSettingsChange = useCallback((newSettings) => {
        setSettings(newSettings);
        setItem(SETTINGS_STORAGE_KEY, newSettings);
        onSettingsChange?.(newSettings);
    }, [onSettingsChange]);
    if (!widgetVisible) {
        return null;
    }
    const handleLinkClick = (e) => {
        e.preventDefault();
        const url = e.currentTarget.href;
        onLinkClick(url);
    };
    const handleContentClick = (message, e) => {
        const target = e.target;
        if (target.tagName === 'A') {
            handleLinkClick(e);
        }
        else {
            if (onMessageReceived && !message.received) {
                onMessageReceived([message.id]);
            }
            setModalMessage(message);
        }
    };
    // Get messages for display: widget mode shows all messages for consistent navigation;
    // list mode prioritises unread messages when available.
    // Apply showReadMessages setting: when disabled, filter out read messages in list mode.
    const unreadMessages = messages.filter(msg => !msg.received);
    const filteredMessages = isListMode && !settings.showReadMessages
        ? unreadMessages
        : messages;
    const allMessagesToShow = isListMode
        ? (unreadMessages.length > 0 && settings.showReadMessages ? filteredMessages : (filteredMessages.length > 0 ? filteredMessages : messages))
        : messages;
    const displayMessage = currentMessage || (!isCollapsed && allMessagesToShow.length > 0 ? allMessagesToShow[0] : null);
    const currentMessageIndex = displayMessage
        ? Math.max(0, allMessagesToShow.findIndex((m) => m.id === displayMessage.id))
        : 0;
    const canGoPrev = !isListMode && allMessagesToShow.length > 1 && currentMessageIndex > 0;
    const canGoNext = !isListMode && allMessagesToShow.length > 1 && currentMessageIndex < allMessagesToShow.length - 1;
    // Extract title from HTML if no title field exists
    const getMessageTitle = (msg) => {
        if (!msg)
            return 'Messages';
        // Try to extract from HTML (first h1, h2, or h3)
        const match = msg.message.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/i);
        return match ? match[1].replace(/<[^>]+>/g, '') : 'Messages';
    };
    return (React.createElement("div", { ref: widgetRef, className: `journy-message-widget ${!isCollapsed ? 'journy-message-widget-expanded' : 'journy-message-widget-collapsed'} ${isDragging ? 'journy-message-widget-dragging' : ''} ${isResizing ? 'journy-message-widget-resizing' : ''}`, style: {
            left: `${position.left}px`,
            top: `${position.top}px`,
            width: `${currentWidth}px`,
            height: `${currentHeight}px`,
            transition: isDragging || isResizing ? 'none' : `height ${TRANSITION_DURATION_S}s ease-out, top ${TRANSITION_DURATION_S}s ease-out`,
        }, onClick: (e) => {
            // Don't toggle if this click was right after a drag (avoids expand when releasing drag at bottom edge)
            if (justFinishedDragging.current) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            // Toggle on click when collapsed, but not if clicking on buttons, drag handle, or content area
            if (!isCollapsed)
                return; // Don't toggle when expanded
            const target = e.target;
            const isButton = target.closest('button');
            const isDragHandle = target.closest('.journy-message-widget-drag-handle');
            const isLink = target.tagName === 'A' || target.closest('a');
            // Only toggle when clicking on header (but not buttons, drag handle, or links)
            if (!isButton && !isDragHandle && !isLink) {
                onToggleExpand();
            }
        } },
        React.createElement("div", { className: "journy-message-widget-header" },
            React.createElement(DragHandle, { onMouseDown: handleMouseDown }),
            React.createElement("div", { className: "journy-message-widget-header-content" }, isCollapsed ? (React.createElement(React.Fragment, null,
                React.createElement("span", { className: "journy-message-widget-badge" }, unreadCount),
                React.createElement("span", { className: "journy-message-widget-title" }, unreadCount > 0 ? 'New Messages' : 'Messages'),
                readCount > 0 && (React.createElement("span", { className: "journy-message-widget-read-count" },
                    "(",
                    readCount,
                    " read)")))) : (React.createElement(React.Fragment, null,
                unreadCount > 0 && (React.createElement("span", { className: "journy-message-widget-badge" }, unreadCount)),
                React.createElement("span", { className: "journy-message-widget-title" }, displayMessage ? getMessageTitle(displayMessage) : allMessagesToShow.length > 0 ? getMessageTitle(allMessagesToShow[0]) : 'Messages'),
                isListMode && allMessagesToShow.length > 1 && (React.createElement("span", { className: "journy-message-widget-message-count" },
                    "(",
                    allMessagesToShow.length,
                    " messages)"))))),
            React.createElement("div", { className: "journy-message-widget-controls" },
                !isCollapsed && (React.createElement("button", { className: "journy-message-widget-settings-btn", onClick: (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        setIsSettingsOpen(true);
                    }, onMouseDown: (e) => e.stopPropagation(), title: "Settings", "aria-label": "Settings" },
                    React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
                        React.createElement("path", { d: "M6.5 1L6.2 2.6C5.8 2.8 5.5 3 5.2 3.2L3.6 2.7L2.1 5.3L3.4 6.3C3.4 6.5 3.3 6.8 3.3 7C3.3 7.2 3.4 7.5 3.4 7.7L2.1 8.7L3.6 11.3L5.2 10.8C5.5 11 5.8 11.2 6.2 11.4L6.5 13H9.5L9.8 11.4C10.2 11.2 10.5 11 10.8 10.8L12.4 11.3L13.9 8.7L12.6 7.7C12.6 7.5 12.7 7.2 12.7 7C12.7 6.8 12.6 6.5 12.6 6.3L13.9 5.3L12.4 2.7L10.8 3.2C10.5 3 10.2 2.8 9.8 2.6L9.5 1H6.5ZM8 5C9.1 5 10 5.9 10 7C10 8.1 9.1 9 8 9C6.9 9 6 8.1 6 7C6 5.9 6.9 5 8 5Z", fill: "currentColor" })))),
                React.createElement("button", { className: "journy-message-widget-toggle", onClick: (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        onToggleExpand();
                    }, onMouseDown: (e) => {
                        e.stopPropagation(); // Prevent drag from starting
                    }, title: !isCollapsed ? 'Collapse' : 'Expand', "aria-label": !isCollapsed ? 'Collapse' : 'Expand' }, !isCollapsed ? '−' : '+'),
                isCollapsed && (React.createElement("button", { className: "journy-message-widget-close", onClick: (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        onCloseWidget ? onCloseWidget() : onClose();
                    }, onMouseDown: (e) => {
                        e.stopPropagation();
                    }, title: "Close widget", "aria-label": "Close" }, "\u00D7")),
                !isCollapsed && isListMode === false && allMessagesToShow.length > 1 && (React.createElement(React.Fragment, null,
                    React.createElement("button", { className: "journy-message-widget-nav", onClick: (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            onPrevMessage?.();
                        }, onMouseDown: (e) => e.stopPropagation(), title: "Previous message", "aria-label": "Previous", disabled: !canGoPrev }, "\u2039"),
                    React.createElement("button", { className: "journy-message-widget-nav", onClick: (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            onNextMessage?.();
                        }, onMouseDown: (e) => e.stopPropagation(), title: "Next message", "aria-label": "Next", disabled: !canGoNext }, "\u203A"))))),
        !isCollapsed && allMessagesToShow.length > 0 && (React.createElement(React.Fragment, null,
            React.createElement("div", { ref: contentRef, className: `journy-message-widget-content ${!isListMode ? 'journy-message-widget-content--single' : ''}` }, isListMode ? (allMessagesToShow.map((message, index) => (React.createElement(MessageRow, { key: message.id, message: message, isSeparated: index < allMessagesToShow.length - 1, onMessageReceived: onMessageReceived, onDismissMessage: onDismissMessage },
                React.createElement("div", { className: "journy-message-content journy-message-content-clickable", dangerouslySetInnerHTML: { __html: sanitizeHtml(message.message) }, onClick: (e) => handleContentClick(message, e) }),
                message.createdAt && (React.createElement("div", { className: "journy-message-timestamp" }, formatTimestamp(message.createdAt))))))) : displayMessage ? (React.createElement(MessageRow, { message: displayMessage, isSeparated: false, onMessageReceived: onMessageReceived, onDismissMessage: onDismissMessage },
                React.createElement("div", { className: "journy-message-content journy-message-content-clickable", dangerouslySetInnerHTML: { __html: sanitizeHtml(displayMessage.message) }, onClick: (e) => handleContentClick(displayMessage, e) }),
                displayMessage.createdAt && (React.createElement("div", { className: "journy-message-timestamp" }, formatTimestamp(displayMessage.createdAt))))) : null),
            !isListMode && allMessagesToShow.length > 1 && (React.createElement("div", { className: "journy-message-widget-position" },
                currentMessageIndex + 1,
                " / ",
                allMessagesToShow.length)),
            isListMode && React.createElement(ResizeHandle, { onMouseDown: handleResizeStart }))),
        !isCollapsed && allMessagesToShow.length === 0 && (React.createElement(React.Fragment, null,
            React.createElement("div", { className: "journy-message-widget-content journy-message-widget-empty" },
                React.createElement("p", null, "No unread messages")),
            isListMode && React.createElement(ResizeHandle, { onMouseDown: handleResizeStart }))),
        !isCollapsed && (React.createElement(SettingsPanel, { isOpen: isSettingsOpen, onClose: () => setIsSettingsOpen(false), settings: settings, onSettingsChange: handleSettingsChange, configInfo: configInfo })),
        modalMessage && (React.createElement(MessagePopup, { message: modalMessage, onClose: () => setModalMessage(null), onLinkClick: onLinkClick }))));
};

var MessageWidgetModule = /*#__PURE__*/Object.freeze({
    __proto__: null,
    MessageWidget: MessageWidget,
    default: MessageWidget
});

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
        this.analyticsHost = config.apiEndpoint || "https://jtm.journy.io";
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

const DEFAULT_API_ENDPOINT = 'https://jtm.journy.io';
const DEFAULT_POLLING_INTERVAL = 30000;
const ROOT_ELEMENT_ID = 'journy-messages-root';
const DEFAULT_STYLE_ID = 'journy-messages-default';
const REACT_CHECK_INTERVAL = 100;
const REACT_WAIT_TIMEOUT = 10000;
const MESSAGE_CLOSE_DELAY = 300;
const STORAGE_KEYS = {
    WIDGET_SETTINGS: 'widget_settings',
    WIDGET_VISIBLE: 'widget_visible',
    WIDGET_COLLAPSED: 'widget_collapsed',
    CURRENT_MESSAGE_ID: 'current_message_id',
};
class JournyMessaging {
    constructor(config) {
        this.initialized = false;
        this.pollingInterval = null;
        this.reactRoot = null;
        this.reactRootContainer = null;
        this.rootElementId = ROOT_ELEMENT_ID;
        this.unsubscribePersistence = null;
        this.config = {
            apiEndpoint: DEFAULT_API_ENDPOINT,
            pollingInterval: DEFAULT_POLLING_INTERVAL,
            ...config,
        };
        if (!this.config.writeKey) {
            throw new Error('writeKey is required');
        }
        if (!this.config.entityType) {
            throw new Error('entityType is required');
        }
        this.apiClient = new ApiClient(this.config);
        this.messageQueue = new MessageQueue();
        this.analyticsClient = new AnalyticsClient(this.config);
        this.eventTracker = new EventTracker(this.analyticsClient);
        // Build default settings from config, then overlay any saved settings
        const configDefaults = {
            ...DEFAULT_WIDGET_SETTINGS,
            pollingInterval: this.config.pollingInterval || DEFAULT_WIDGET_SETTINGS.pollingInterval,
            displayMode: this.config.displayMode || DEFAULT_WIDGET_SETTINGS.displayMode,
            apiEndpoint: this.config.apiEndpoint || DEFAULT_WIDGET_SETTINGS.apiEndpoint,
            styles: this.config.styles || DEFAULT_WIDGET_SETTINGS.styles,
        };
        const savedSettings = getItem(STORAGE_KEYS.WIDGET_SETTINGS);
        this.widgetSettings = savedSettings
            ? { ...configDefaults, ...savedSettings }
            : configDefaults;
        // Apply settings back to config so they take effect
        this.config.pollingInterval = this.widgetSettings.pollingInterval;
        this.config.apiEndpoint = this.widgetSettings.apiEndpoint;
        this.config.displayMode = this.widgetSettings.displayMode;
        const savedVisible = getItem(STORAGE_KEYS.WIDGET_VISIBLE);
        const savedCollapsed = getItem(STORAGE_KEYS.WIDGET_COLLAPSED);
        this.store = new MessagingStore({
            messages: [],
            currentMessage: null,
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
        // Load existing messages
        await this.loadMessages();
        // Set up polling or WebSocket connection
        this.startPolling();
        // Initialize UI
        this.initializeUI();
        this.initialized = true;
    }
    async loadMessages() {
        try {
            const messages = await this.apiClient.getUnreadMessages();
            const previousActiveCount = this.messageQueue.getActiveCount();
            this.messageQueue.addMessages(messages);
            const newActiveCount = this.messageQueue.getActiveCount();
            let updates = {
                messages: this.messageQueue.getAllMessages(),
            };
            if (newActiveCount > previousActiveCount) {
                updates.widgetVisible = true;
                if (this.widgetSettings.autoExpandOnNew) {
                    updates.isCollapsed = false;
                }
            }
            this.store.setState(updates);
            if (!this.uiState.currentMessage && newActiveCount > 0) {
                const savedMessageId = getItem(STORAGE_KEYS.CURRENT_MESSAGE_ID);
                const allMessages = this.messageQueue.getAllMessages();
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
        }
        catch (error) {
            console.error('Failed to load messages:', error);
        }
    }
    startPolling() {
        if (this.pollingInterval !== null) {
            clearInterval(this.pollingInterval);
        }
        this.pollingInterval = window.setInterval(() => {
            this.loadMessages();
        }, this.config.pollingInterval || DEFAULT_POLLING_INTERVAL);
    }
    applyStyles(stylesConfig) {
        removeInjectedStyles();
        if (stylesConfig === 'none') ;
        else if (stylesConfig && stylesConfig !== 'default') {
            if ('url' in stylesConfig && stylesConfig.url) {
                injectStyleLink(stylesConfig.url);
            }
            else if ('css' in stylesConfig && stylesConfig.css) {
                injectStyleTag(stylesConfig.css);
            }
        }
        else {
            injectStyleTag(defaultStyles, DEFAULT_STYLE_ID);
        }
    }
    initializeUI() {
        // Create root element for React
        const rootElement = createRootElement(this.rootElementId);
        this.applyStyles(this.widgetSettings.styles);
        // Always render UI (even if no messages) so widget can show/hide itself
        // Dynamically import React and render component
        // This will be handled when React is available
        if (typeof window !== 'undefined' && window.React && window.ReactDOM) {
            this.renderUI(rootElement);
        }
        else {
            this.waitForReact(rootElement);
        }
    }
    waitForReact(rootElement) {
        const checkInterval = setInterval(() => {
            if (typeof window !== 'undefined' && window.React && window.ReactDOM) {
                clearInterval(checkInterval);
                this.renderUI(rootElement);
            }
        }, REACT_CHECK_INTERVAL);
        setTimeout(() => {
            clearInterval(checkInterval);
        }, REACT_WAIT_TIMEOUT);
    }
    renderUI(rootElement) {
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
            // Access MessageWidget from the statically imported module
            const MessageWidget$1 = MessageWidget || MessageWidget;
            if (!MessageWidget$1) {
                console.error('MessageWidget not found in module:', MessageWidgetModule);
                throw new Error('MessageWidget not found in module');
            }
            const props = {
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
            };
            const element = React.createElement(MessageWidget$1, props);
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
    handleSettingsChange(newSettings) {
        const prev = this.widgetSettings;
        this.widgetSettings = newSettings;
        setItem(STORAGE_KEYS.WIDGET_SETTINGS, newSettings);
        // Sync config
        this.config.pollingInterval = newSettings.pollingInterval;
        this.config.apiEndpoint = newSettings.apiEndpoint;
        // Restart polling if interval changed
        if (newSettings.pollingInterval !== prev.pollingInterval) {
            this.startPolling();
        }
        // Switch display mode
        if (newSettings.displayMode !== prev.displayMode) {
            this.store.setState({ displayMode: newSettings.displayMode });
        }
        // Re-apply styles if changed
        if (JSON.stringify(newSettings.styles) !== JSON.stringify(prev.styles)) {
            this.applyStyles(newSettings.styles);
        }
        // Rebuild API client if endpoint or proxy changed
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
            }, MESSAGE_CLOSE_DELAY);
        }
    }
    handleCloseWidget() {
        this.store.setState({ widgetVisible: false });
    }
    async handleDismissMessage(messageId) {
        this.eventTracker.track(SDKEventType.MessageClosed, { messageId });
        await this.markAsRead([messageId]);
        if (this.uiState.currentMessage?.id === messageId) {
            this.store.setState({ currentMessage: null });
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
        const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]);
        const alreadyReceivedIds = this.messageQueue.getAlreadyReceivedIds(ids);
        if (alreadyReceivedIds.length === ids.length)
            return;
        // Track locally first to prevent duplicate sends
        this.messageQueue.markMessageAsReceived(ids);
        // Update currentMessage so re-render reflects received status immediately
        const { currentMessage } = this.uiState;
        const updates = {
            messages: this.messageQueue.getAllMessages(),
        };
        if (currentMessage && ids.includes(currentMessage.id)) {
            updates.currentMessage = { ...currentMessage, received: true };
        }
        this.store.setState(updates);
        await this.apiClient.markAsRead(ids);
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
        if (this.pollingInterval !== null) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        if (this.unsubscribePersistence) {
            this.unsubscribePersistence();
            this.unsubscribePersistence = null;
        }
        this.eventTracker.destroy();
        this.store.destroy();
        // Unmount React root before removing element
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
        removeRootElement(this.rootElementId);
        removeInjectedStyles();
    }
}

// For UMD/global usage
if (typeof window !== 'undefined') {
    window.JournyMessages = JournyMessaging;
}

export { JournyMessaging, JournyMessaging as default };
//# sourceMappingURL=journy-messages.esm.js.map
