// Foreman for Chrome: the toolbar popup. It shows the connection state that background.js keeps in
// chrome.storage.session, lists the workspaces using this browser, and offers Stop all.

const STATUS_TEXT = { connected: 'Connected', waiting: 'Waiting', offline: 'Not running' }

const statusEl = document.getElementById('status')
const bodyEl = document.getElementById('body')
const stopButton = document.getElementById('stop')
const idEl = document.getElementById('browser-id')

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function block(title, detail) {
  const section = element('section', 'block')
  section.append(element('p', 'title', title), element('p', 'detail', detail))
  return section
}

function groupRow(group) {
  const row = element('li', 'group')
  row.append(element('span', 'group-title', group.title || 'Workspace'))
  if (group.agent) row.append(element('span', 'group-agent', group.agent))
  if (group.working) row.append(element('span', 'group-working', 'Working'))
  return row
}

function render(state) {
  const connection = state?.connection ?? 'offline'
  statusEl.textContent = STATUS_TEXT[connection] ?? STATUS_TEXT.offline
  statusEl.dataset.state = connection
  stopButton.hidden = connection !== 'connected'
  bodyEl.replaceChildren()

  if (connection === 'connected') {
    const name = state.name ? `Connected as ${state.name}` : 'Connected'
    bodyEl.append(element('p', 'title', name))
    const groups = state.groups ?? []
    if (groups.length === 0) {
      bodyEl.append(element('p', 'detail', 'No workspace is using this browser yet.'))
    } else {
      const list = element('ul', 'groups')
      for (const group of groups) list.append(groupRow(group))
      bodyEl.append(list)
    }
  } else if (connection === 'waiting') {
    bodyEl.append(block('Allow this browser in Foreman', 'Open Foreman → Settings → Browser and click Allow. Nothing to type here.'))
  } else {
    bodyEl.append(block("Foreman isn't open", 'Open Foreman on this computer, then click here again.'))
  }
}

async function showBrowserId() {
  const { installId } = await chrome.storage.local.get('installId')
  if (!installId) return
  idEl.textContent = `Browser id: ${installId.slice(0, 8)}`
  idEl.hidden = false
}

stopButton.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'stop-all' }).catch(() => {})
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.state) render(changes.state.newValue)
})

async function init() {
  void chrome.runtime.sendMessage({ type: 'popup-open' }).catch(() => {})
  const { state } = await chrome.storage.session.get('state')
  render(state)
  await showBrowserId()
}

void init()
