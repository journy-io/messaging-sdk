export declare enum SDKEventType {
    MessageReceived = "In-App Message Received",
    MessageOpened = "In-App Message Opened",
    MessageClosed = "In-App Message Closed",
    MessageLinkClicked = "In-App Message Link Clicked"
}
export type MessageStatus = 'pending' | 'sent' | 'read' | 'expired';
export type MessageScope = 'account' | 'user';
export type AppDisplayMode = 'widget' | 'list' | 'banner';
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
//# sourceMappingURL=types.d.ts.map