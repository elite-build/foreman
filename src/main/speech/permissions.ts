// Which permission requests the main window's page may have granted. Electron approves every request when no handler
// is set, so the window gets one: the microphone (an audio-only `media` request from the app's own main frame) and
// nothing else under `media`, and no screen capture. Every other kind of permission keeps the behaviour it had before
// the handler existed.

export interface MediaRequestDetails {
  mediaTypes?: ('video' | 'audio')[]
  isMainFrame?: boolean
}

export function allowPermission(permission: string, details: MediaRequestDetails, fromAppWindow: boolean): boolean {
  // Electron 45 asks for screen, window and tab capture as `display-capture`; earlier versions asked under `media`.
  if (permission === 'display-capture') return false
  if (permission !== 'media') return true
  return fromAppWindow && details.isMainFrame !== false && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio'
}

// Packaging note: macOS also needs the hardened-runtime entitlement com.apple.security.device.audio-input in the
// app's entitlements once signing is set up (NSMicrophoneUsageDescription is already in package.json's mac.extendInfo).
