export declare enum SDKEventType {
    MessageReceived = "In-App Message Received",
    MessageOpened = "In-App Message Opened",
    MessageClosed = "In-App Message Closed",
    MessageLinkClicked = "In-App Message Link Clicked"
}
export type MessageStatus = 'pending' | 'sent' | 'read' | 'expired';
export type MessageScope = 'account' | 'user';
export type AppDisplayMode = 'widget' | 'list';
export type RenderTarget = 'self' | 'parent' | 'top';
export type BannerPosition = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
export interface Message {
    id: string;
    appId: string;
    accountId?: string;
    userId?: string;
    status: MessageStatus;
    scope: MessageScope;
    message: string;
    isBanner?: boolean;
    received: boolean;
    expired: boolean;
    createdAt: string;
    expiredAt?: string;
}
export type StylesConfig = 'default' | 'none' | {
    url: string;
} | {
    css: string;
};
export interface WidgetSettings {
    pollingInterval: number;
    showReadMessages: boolean;
    autoExpandOnNew: boolean;
    displayMode: AppDisplayMode;
    bannerPosition: BannerPosition;
    /**
     * Auto-dismiss delay (ms) for banner mode. `0` disables auto-dismiss.
     * Defaults to BANNER_AUTO_DISMISS_MS (20 000 ms).
     */
    bannerAutoDismissMs: number;
    apiEndpoint: string;
    styles: StylesConfig;
}
export interface ApiResponse<T> {
    data: T;
    success: boolean;
    error?: string;
}
export type SDKErrorKind = 'rate-limited' | 'http' | 'network';
export interface SDKError {
    kind: SDKErrorKind;
    message: string;
    /** Absent for network failures, which never reached the server. */
    status?: number;
    /** Seconds the server asked us to wait. Only ever set for 'rate-limited'. */
    retryAfterSeconds?: number;
}
/**
 * Callers need to tell "no messages" apart from "the request failed". Returning
 * an empty list for both is what makes a rate-limited widget look like an empty
 * inbox, so every request reports which of the two happened.
 */
export type ApiResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: SDKError;
};
//# sourceMappingURL=types.d.ts.map