# Foreman for Chrome

Foreman for Chrome lets the coding agents running in Foreman use the tabs of your own browser, with your logins.
It works in Chrome, Edge and Brave (any Chromium browser). It is a small extension that talks to Foreman through
Chrome's native messaging.

## Install for development

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder (`resources/chrome-extension`).

## Before it works

- Foreman must be running on this computer, with **Settings → Browser** turned on.
- In Foreman, allow this browser once under **Settings → Browser → Allow**. The toolbar icon shows `!` until you do.

## What agents can see

Each Foreman workspace gets its own tab group in your browser. An agent only sees and acts on tabs inside its
workspace's group. Tabs outside the group are never visible to it. Closing a group's tabs or pressing **Stop all**
in the popup ends the agent's access.

## Stop all

Click the toolbar icon and press **Stop all**. The extension detaches its debugger from every tab, forgets the
workspace groups (the tabs stay open) and tells Foreman to stop.
