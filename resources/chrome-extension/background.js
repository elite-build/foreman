// Foreman for Chrome: the service worker. It keeps a native-messaging connection to Foreman (host com.foreman.browser),
// reports which browser this is, and runs the browser tools Foreman asks for, only on tabs inside each workspace's
// tab group. The message shapes are the contract in src/shared/browserLink.ts.

const HOST = 'com.foreman.browser'
const RETRY_MS = [5000, 10000, 30000, 60000]
const LOAD_TIMEOUT_MS = 15000
const SNAPSHOT_MAX = 20000
const TEXT_MAX = 200
const NOT_IN_GROUP = "That tab isn't in this workspace's tab group."
const GROUP_COLORS = ['blue', 'green', 'purple', 'orange', 'cyan', 'pink', 'yellow', 'red']
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'tab', 'switch', 'slider'
])

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 }
}

let port = null
let retryStep = 0
let retryTimer = null
// Debugger attachments and element refs live in memory; a restarted worker re-attaches on demand.
const attached = new Set()
const refsByTab = new Map()
// Storage read-modify-write steps run one at a time so parallel requests cannot clobber each other.
let queue = Promise.resolve()

function serial(fn) {
  const run = queue.then(fn)
  queue = run.catch(() => {})
  return run
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

// ---- state shown by the popup and the toolbar badge ----

async function readState() {
  const { state } = await chrome.storage.session.get('state')
  return state ?? { connection: 'offline' }
}

function writeState(next) {
  return serial(async () => {
    await chrome.storage.session.set({ state: next })
    await chrome.action.setBadgeBackgroundColor({ color: '#e37400' })
    await chrome.action.setBadgeText({ text: next.connection === 'waiting' ? '!' : '' })
  })
}

function getInstallId() {
  return serial(async () => {
    const { installId } = await chrome.storage.local.get('installId')
    if (installId) return installId
    const fresh = crypto.randomUUID()
    await chrome.storage.local.set({ installId: fresh })
    return fresh
  })
}

function browserKind() {
  if (navigator.brave !== undefined) return 'brave'
  const brands = (navigator.userAgentData?.brands ?? []).map((b) => String(b.brand ?? '').toLowerCase())
  if (brands.some((b) => b.includes('edge'))) return 'edge'
  if (brands.some((b) => b.includes('google chrome'))) return 'chrome'
  if (brands.some((b) => b.includes('chromium'))) return 'chromium'
  return 'other'
}

// ---- the native-messaging connection ----

async function connect() {
  if (port) return
  clearTimeout(retryTimer)
  retryTimer = null
  const installId = await getInstallId()
  if (port) return
  let next
  try {
    next = chrome.runtime.connectNative(HOST)
  } catch {
    scheduleRetry()
    return
  }
  port = next
  next.onMessage.addListener(onHostMessage)
  next.onDisconnect.addListener(onHostDisconnect)
  next.postMessage({
    type: 'hello',
    installId,
    kind: browserKind(),
    version: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent
  })
  await writeState({ connection: 'waiting' })
}

function scheduleRetry() {
  clearTimeout(retryTimer)
  const delay = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)]
  retryStep += 1
  retryTimer = setTimeout(() => {
    retryTimer = null
    void connect()
  }, delay)
}

function onHostDisconnect() {
  // Reading lastError marks the disconnect reason as handled.
  void chrome.runtime.lastError
  port = null
  void writeState({ connection: 'offline' })
  scheduleRetry()
}

async function onHostMessage(message) {
  if (!message || typeof message !== 'object') return
  if (message.type === 'status') {
    retryStep = 0
    if (message.allowed) {
      await writeState({ connection: 'connected', name: message.name, groups: message.groups ?? [] })
    } else {
      await writeState({ connection: 'waiting' })
    }
    return
  }
  if (message.type === 'request') {
    const reply = await runRequest(message)
    try {
      port?.postMessage(reply)
    } catch {
      // The connection closed while the work ran; Foreman will see the disconnect.
    }
  }
}

async function runRequest(request) {
  try {
    const params = request.params ?? {}
    if (typeof params.group !== 'string' || params.group === '') throw new Error('The request names no workspace.')
    const result = await runMethod(request.method, params)
    return { type: 'response', id: request.id, ok: true, result }
  } catch (error) {
    return { type: 'response', id: request.id, ok: false, error: errorText(error) }
  }
}

function runMethod(method, params) {
  switch (method) {
    case 'tabs': return listTabs(params)
    case 'open': return openTab(params)
    case 'navigate': return navigate(params)
    case 'snapshot': return snapshot(params)
    case 'click': return click(params)
    case 'type': return typeInto(params)
    case 'press': return press(params)
    case 'screenshot': return screenshot(params)
    case 'close': return closeTab(params)
    default: throw new Error(`Unknown method: ${method}`)
  }
}

// ---- workspace tab groups ----

async function getGroupMap() {
  const { groupMap } = await chrome.storage.session.get('groupMap')
  return groupMap ?? {}
}

function setGroupMap(map) {
  return chrome.storage.session.set({ groupMap: map })
}

function colorFor(group) {
  let hash = 0
  for (const ch of group) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return GROUP_COLORS[hash % GROUP_COLORS.length]
}

async function groupExists(groupId) {
  try {
    await chrome.tabGroups.get(groupId)
    return true
  } catch {
    return false
  }
}

// The tab, if it is in this workspace's group. Every tab method goes through here.
async function ownedTab(group, tabId) {
  if (!Number.isInteger(tabId)) throw new Error(NOT_IN_GROUP)
  const groupId = (await getGroupMap())[group]
  if (groupId === undefined) throw new Error(NOT_IN_GROUP)
  let tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    throw new Error(NOT_IN_GROUP)
  }
  if (tab.groupId !== groupId) throw new Error(NOT_IN_GROUP)
  return tab
}

function tabInfo(tab) {
  return { tabId: tab.id, title: tab.title ?? '', url: tab.url ?? '', active: Boolean(tab.active) }
}

function checkUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("That isn't a valid URL.")
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http and https pages can be opened.')
}

async function listTabs({ group }) {
  const groupId = (await getGroupMap())[group]
  if (groupId === undefined) return { tabs: [] }
  const tabs = await chrome.tabs.query({ groupId })
  return { tabs: tabs.map(tabInfo) }
}

async function addToGroup(group, title, tabId) {
  const map = await getGroupMap()
  const existing = map[group]
  if (existing !== undefined && (await groupExists(existing))) {
    await chrome.tabs.group({ groupId: existing, tabIds: tabId })
    // Keep the title Foreman sends, so a group made by an older version is renamed too.
    await chrome.tabGroups.update(existing, { title: title || 'Foreman' })
    return
  }
  const groupId = await chrome.tabs.group({ tabIds: tabId })
  await chrome.tabGroups.update(groupId, { title: title || 'Foreman', color: colorFor(group) })
  await setGroupMap({ ...map, [group]: groupId })
}

// Resolves when the tab has finished loading, or after LOAD_TIMEOUT_MS. checkCurrent: a tab that is already
// complete counts (a new tab); after a navigation the old page's state must not count.
function waitForLoad(tabId, checkCurrent) {
  return new Promise((resolve) => {
    let timer = null
    const finish = () => {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      resolve()
    }
    const onUpdated = (id, change) => {
      if (id === tabId && change.status === 'complete') finish()
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
    timer = setTimeout(finish, LOAD_TIMEOUT_MS)
    if (checkCurrent) {
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === 'complete') finish()
      }, finish)
    }
  })
}

// ---- tab methods ----

async function openTab({ group, groupTitle, url }) {
  checkUrl(url)
  const tab = await chrome.tabs.create({ url, active: true })
  await serial(() => addToGroup(group, groupTitle, tab.id))
  await waitForLoad(tab.id, true)
  return tabInfo(await chrome.tabs.get(tab.id))
}

async function navigate({ group, tabId, url }) {
  await ownedTab(group, tabId)
  checkUrl(url)
  await chrome.tabs.update(tabId, { url })
  await waitForLoad(tabId, false)
  const tab = await chrome.tabs.get(tabId)
  return { title: tab.title ?? '', url: tab.url ?? '' }
}

async function closeTab({ group, tabId }) {
  await ownedTab(group, tabId)
  await chrome.tabs.remove(tabId)
  return { ok: true }
}

async function screenshot({ group, tabId }) {
  await ownedTab(group, tabId)
  await attach(tabId)
  const { data } = await cdp(tabId, 'Page.captureScreenshot', { format: 'png' })
  return { png: data }
}

// ---- the debugger (Chrome DevTools Protocol) ----

function cdp(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message))
      else resolve(result)
    })
  })
}

async function attach(tabId) {
  if (attached.has(tabId)) return
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
  } catch (error) {
    if (!/already attached/i.test(errorText(error))) throw error
  }
  attached.add(tabId)
}

function forget(tabId) {
  attached.delete(tabId)
  refsByTab.delete(tabId)
}

function cut(text, max) {
  return text.length > max ? text.slice(0, max) : text
}

function property(node, name) {
  return (node.properties ?? []).find((p) => p.name === name)?.value?.value
}

function isSecret(node) {
  if (String(property(node, 'protected')) === 'true') return true
  const autocomplete = String(property(node, 'autocomplete') ?? '')
  const name = String(node.name?.value ?? '')
  return /password/i.test(autocomplete) || /password/i.test(name)
}

async function snapshot({ group, tabId }) {
  const tab = await ownedTab(group, tabId)
  await attach(tabId)
  const { nodes = [] } = await cdp(tabId, 'Accessibility.getFullAXTree')
  const refs = new Map()
  const lines = []
  for (const node of nodes) {
    if (node.ignored) continue
    const role = node.role?.value
    const name = cut(String(node.name?.value ?? '').trim(), TEXT_MAX)
    const label = name ? ` ${JSON.stringify(name)}` : ''
    if (role === 'StaticText') {
      if (name) lines.push(`text ${JSON.stringify(name)}`)
      continue
    }
    if (role === 'heading') {
      lines.push(`heading${label}`)
      continue
    }
    if (role === 'img') {
      if (name) lines.push(`img ${JSON.stringify(name)}`)
      continue
    }
    if (!INTERACTIVE_ROLES.has(role) || node.backendDOMNodeId === undefined) continue
    const ref = `e${refs.size + 1}`
    refs.set(ref, node.backendDOMNodeId)
    let line = `[${ref}] ${role}${label}`
    if (role === 'textbox') {
      const value = node.value?.value
      if (value !== undefined && String(value) !== '') {
        line += isSecret(node) ? ' value="••••"' : ` value=${JSON.stringify(cut(String(value), TEXT_MAX))}`
      }
    }
    if ((role === 'checkbox' || role === 'radio') && [true, 'true'].includes(property(node, 'checked'))) line += ' checked'
    lines.push(line)
  }
  refsByTab.set(tabId, refs)
  let text = lines.join('\n')
  if (text.length > SNAPSHOT_MAX) text = `${text.slice(0, SNAPSHOT_MAX)}\n… (cut)`
  return { title: tab.title ?? '', url: tab.url ?? '', text }
}

// The debugger backend node for a ref from the latest snapshot of this tab.
async function elementFor(group, tabId, ref) {
  await ownedTab(group, tabId)
  const backendNodeId = refsByTab.get(tabId)?.get(ref)
  if (backendNodeId === undefined) throw new Error('Unknown ref: take a new browser_snapshot.')
  await attach(tabId)
  return backendNodeId
}

async function click({ group, tabId, ref }) {
  const backendNodeId = await elementFor(group, tabId, ref)
  await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
  const { model } = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId })
  const q = model.content
  const point = { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 }
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  return { ok: true }
}

async function typeInto({ group, tabId, ref, text, submit }) {
  const backendNodeId = await elementFor(group, tabId, ref)
  await cdp(tabId, 'DOM.focus', { backendNodeId })
  await cdp(tabId, 'Input.insertText', { text: String(text ?? '') })
  if (submit) await sendKey(tabId, KEYS.Enter)
  return { ok: true }
}

function keyFor(name) {
  const entry = Object.hasOwn(KEYS, name === ' ' ? 'Space' : name) ? KEYS[name === ' ' ? 'Space' : name] : null
  if (!entry) throw new Error(`Unknown key: ${name}. Use Enter, Escape, Tab, Backspace, Delete, an arrow key, Space, Home, End, PageUp or PageDown.`)
  return entry
}

async function sendKey(tabId, key) {
  const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk }
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key.text ? { text: key.text } : {}) })
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

async function press({ group, tabId, key }) {
  const entry = keyFor(key)
  await ownedTab(group, tabId)
  await attach(tabId)
  await sendKey(tabId, entry)
  return { ok: true }
}

// ---- Foreman messages and Stop all ----

async function stopAll() {
  for (const tabId of [...attached]) {
    try {
      await chrome.debugger.detach({ tabId })
    } catch {
      // Already detached.
    }
  }
  attached.clear()
  refsByTab.clear()
  await serial(() => setGroupMap({}))
  const state = await readState()
  await writeState({ ...state, groups: [] })
  try {
    port?.postMessage({ type: 'stop-all' })
  } catch {
    // Not connected; nothing to tell Foreman.
  }
}

async function start() {
  await writeState({ connection: 'offline' })
  await connect()
}

chrome.runtime.onInstalled.addListener(() => {
  void start()
})
chrome.runtime.onStartup.addListener(() => {
  void start()
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false
  if (message?.type === 'popup-open') {
    void connect()
    sendResponse({ ok: true })
    return false
  }
  if (message?.type === 'stop-all') {
    void stopAll().then(() => sendResponse({ ok: true }))
    return true
  }
  return false
})

chrome.debugger.onDetach.addListener((source) => forget(source.tabId))
chrome.tabs.onRemoved.addListener((tabId) => forget(tabId))
