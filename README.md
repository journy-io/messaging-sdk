# @journyio/messaging-sdk

A standalone JavaScript library for displaying in-app messages from Journy. This library can be integrated via a `<script>` tag, ES modules, or npm package, similar to analytics libraries like Segment or Google Analytics.

## Features

- 🚀 **Standalone Library**: Works without a build step in the host application
- ⚛️ **React Support**: Automatically renders React components when React is available
- 🔒 **XSS Protection**: Built-in HTML sanitization using DOMPurify
- 📦 **Lightweight**: Minimal dependencies, small bundle size
- 🎨 **Customizable**: Flexible styling and message types
- 📊 **Event Tracking**: Automatic tracking of message interactions
- 🔄 **Message Queue**: Smart queue management with priority support
- ⏱️ **Auto-polling**: Automatically fetches new messages

## Installation

### Method 1: Script Tag (Simplest)

```html
<!DOCTYPE html>
<html>
<head>
  <title>My App</title>
</head>
<body>
  <!-- Your app content -->

  <!-- Load React and ReactDOM (if not already loaded) -->
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>

  <!-- Load Journy Messages Library -->
  <script src="https://cdn.journy.io/messages/journy-messages.min.js"></script>

  <script>
    // Initialize
    const messaging = new JournyMessages({
      writeKey: 'your-write-key',
      userId: 'user-123',
      entityType: 'user',
    });
  </script>
</body>
</html>
```

### Method 2: npm Package

```bash
npm install @journyio/messaging-sdk
```

```javascript
import React from 'react';
import ReactDOM from 'react-dom';
import { JournyMessaging } from '@journyio/messaging-sdk';

// Make React available globally for the SDK's internal rendering
window.React = React;
window.ReactDOM = ReactDOM;

const messaging = new JournyMessaging({
  writeKey: 'your-write-key',
  userId: 'user-123',
  entityType: 'user',
});
```

### Method 3: ES Modules

```javascript
import JournyMessages from '@journyio/messaging-sdk';

const messaging = new JournyMessages({
  writeKey: 'your-write-key',
  userId: 'user-123',
  entityType: 'user',
});
```

> **Note**: The SDK renders its widget using `window.React` and `window.ReactDOM`. In a bundled React app these are not on `window` by default — you must assign them before creating a `JournyMessaging` instance. When using script tags, the UMD builds set these globals automatically.

## React Integration

### Using a Component

Create a reusable component that initializes and cleans up the SDK:

```tsx
// src/components/JournyWidget.tsx
import { useEffect, useRef } from 'react';
import React from 'react';
import ReactDOM from 'react-dom';
import { JournyMessaging } from '@journyio/messaging-sdk';

window.React = React;
window.ReactDOM = ReactDOM;

interface Props {
  writeKey: string;
  userId?: string;
  accountId?: string;
  entityType: 'user' | 'account';
}

export function JournyWidget({ writeKey, userId, accountId, entityType }: Props) {
  const messagingRef = useRef<JournyMessaging | null>(null);

  useEffect(() => {
    messagingRef.current = new JournyMessaging({
      writeKey,
      entityType,
      userId,
      accountId,
    });

    return () => {
      messagingRef.current?.destroy();
      messagingRef.current = null;
    };
  }, [writeKey, entityType, userId, accountId]);

  return null; // The SDK manages its own DOM
}
```

Then use it anywhere in your app:

```tsx
import { JournyWidget } from './components/JournyWidget';

function App() {
  return (
    <div>
      <h1>My Application</h1>
      <JournyWidget
        writeKey="your-write-key"
        entityType="user"
        userId="user-123"
      />
    </div>
  );
}
```

### Using a Custom Hook (after authentication)

A common pattern is to start the widget only after the user logs in:

```tsx
// src/hooks/useJournyMessaging.ts
import { useEffect, useRef } from 'react';
import React from 'react';
import ReactDOM from 'react-dom';
import { JournyMessaging } from '@journyio/messaging-sdk';

window.React = React;
window.ReactDOM = ReactDOM;

export function useJournyMessaging(user: { id: string } | null) {
  const messagingRef = useRef<JournyMessaging | null>(null);

  useEffect(() => {
    if (!user) return;

    messagingRef.current = new JournyMessaging({
      writeKey: 'your-write-key',
      entityType: 'user',
      userId: user.id,
    });

    return () => {
      messagingRef.current?.destroy();
      messagingRef.current = null;
    };
  }, [user?.id]);

  return messagingRef;
}
```

```tsx
// src/App.tsx
import { useJournyMessaging } from './hooks/useJournyMessaging';
import { useAuth } from './auth';

function App() {
  const { user } = useAuth();
  useJournyMessaging(user);

  return <div>{/* your app */}</div>;
}
```

## Configuration

### Basic Configuration

```typescript
const messaging = new JournyMessaging({
  writeKey: 'your-write-key',        // Required: Your Journy write key
  userId: 'user-123',                 // Optional: User ID
  accountId: 'account-456',           // Optional: Account ID
  entityType: 'user',                 // Required: 'user' or 'account'
  apiEndpoint: 'https://jtm.journy.io', // Optional: API base URL
  pollingInterval: 30000,            // Optional: Polling interval in ms (default: 30000)
  isCollapsed: false,                // Optional: Start collapsed or expanded
  renderTarget: 'self',             // Optional: 'self', 'parent', or 'top'
});
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `writeKey` | `string` | Yes | - | Your Journy write key for authentication |
| `userId` | `string` | No | - | Current user ID |
| `accountId` | `string` | No | - | Current account ID |
| `entityType` | `'user' \| 'account'` | Yes | - | Type of entity to fetch messages for |
| `apiEndpoint` | `string` | No | `'https://jtm.journy.io'` | API base URL |
| `pollingInterval` | `number` | No | `30000` | Interval in milliseconds to poll for new messages |
| `isCollapsed` | `boolean` | No | `false` | Whether the widget starts collapsed |
| `styles` | `'default' \| 'none' \| { url: string } \| { css: string }` | No | `'default'` | Style injection mode |
| `renderTarget` | `'self' \| 'parent' \| 'top'` | No | `'self'` | Which document to render the widget in (useful for iframes) |

## API Reference

### Methods

#### `markAsRead(messageId: string): Promise<void>`

Marks a message as read and removes it from the queue.

```typescript
await messaging.markAsRead('message-123');
```

#### `trackLinkClick(messageId: string, linkUrl: string): void`

Tracks when a user clicks a link in a message.

```typescript
messaging.trackLinkClick('message-123', 'https://example.com');
```

#### `trackMessageClosed(messageId: string): void`

Tracks when a user closes a message.

```typescript
messaging.trackMessageClosed('message-123');
```

#### `trackMessageOpened(messageId: string): void`

Tracks when a message is opened/displayed.

```typescript
messaging.trackMessageOpened('message-123');
```

#### `destroy(): void`

Cleans up the messaging instance, stops polling, and removes UI elements.

```typescript
messaging.destroy();
```

## Message Format

Messages from the API should follow this format:

```typescript
interface Message {
  id: string;
  content: string;              // HTML content (will be sanitized)
  title?: string;               // Optional title
  type?: 'info' | 'success' | 'warning' | 'error';
  priority?: number;            // Higher numbers = higher priority
  createdAt: string;           // ISO 8601 timestamp
  expiresAt?: string;          // ISO 8601 timestamp
  actions?: MessageAction[];   // Optional action buttons
  metadata?: Record<string, any>;
}

interface MessageAction {
  label: string;
  url?: string;
  action?: string;
  style?: 'primary' | 'secondary' | 'link';
}
```

## Styling

### Default styles

When you do not pass a `styles` option (or set `styles: 'default'`), the SDK **injects the default styles automatically**. You do not need to add a `<link>` tag; a single script tag is enough for the widget to look correct.

If you prefer to load the CSS yourself (e.g. for caching), you can still link the built file and set `styles: 'none'` then include `journy-messages.css` in your page—but the typical use is to omit `styles` and let the SDK inject the default CSS.

### Configurable styles

You can control styling via the `styles` config option:

- **`styles: 'default'` or omitted** – The SDK injects the default styles inline. No separate CSS file needed.
- **`styles: 'none'`** – No SDK styles are injected. You provide all CSS (e.g. target `.journy-message-widget`, `.journy-message-popup`, etc.) in your own stylesheet.
- **`styles: { url: 'https://...' }`** – The SDK injects a `<link rel="stylesheet" href="...">` pointing to your stylesheet.
- **`styles: { css: '.journy-message-widget { ... }' }`** – The SDK injects a `<style>` tag with the given CSS.

Example with custom stylesheet URL:

```javascript
const messaging = new JournyMessages({
  writeKey: 'your-write-key',
  entityType: 'user',
  styles: { url: 'https://my-app.com/journy-messages-theme.css' },
});
```

Example with no library styles (you style everything):

```javascript
const messaging = new JournyMessages({
  writeKey: 'your-write-key',
  entityType: 'user',
  styles: 'none',
});
```

See `examples/alternative-styles.html` and `examples/alternative-styles.css` for a test theme and `styles: { url: '...' }` usage.

### Overriding default styles

When using default styles, you can still customize by overriding these CSS classes in your own CSS:

- `.journy-message-overlay` - The backdrop overlay
- `.journy-message-popup` - The message popup container
- `.journy-message-title` - Message title
- `.journy-message-content` - Message content area
- `.journy-message-close` - Close button
- `.journy-message-actions` - Action buttons container
- `.journy-message-action` - Individual action button

### Message Type Classes

- `.journy-message-info` - Info messages (blue border)
- `.journy-message-success` - Success messages (green border)
- `.journy-message-warning` - Warning messages (orange border)
- `.journy-message-error` - Error messages (red border)

## Rendering Inside an Iframe

If the SDK is loaded inside an iframe and you want the widget to appear on the parent page:

```javascript
const messaging = new JournyMessages({
  writeKey: 'your-write-key',
  entityType: 'user',
  userId: 'user-123',
  renderTarget: 'parent', // or 'top' for the top-level window
});
```

The parent page must be same-origin. If cross-origin, the SDK falls back to rendering inside the iframe.

## Security

### XSS Prevention

The library uses [DOMPurify](https://github.com/cure53/DOMPurify) to sanitize all HTML content before rendering. Only the following HTML tags and attributes are allowed:

**Allowed Tags:**
- `a`, `b`, `i`, `em`, `strong`, `p`, `br`, `ul`, `ol`, `li`

**Allowed Attributes:**
- `href`, `target`, `rel` (for links)

All other HTML is stripped to prevent XSS attacks.

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

## License

MIT

## Support

For issues and questions, please visit [GitHub Issues](https://github.com/journy-io/journy-in-app-messages/issues).
