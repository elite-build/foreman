// A cloud terminal's `state` (read-only while its sandbox sleeps) is optional: local terminals never send one.
type Listener = { data(data: string): void; exit(code: number): void; state?(asleep: boolean, reason?: string): void }
type Event = { data: string } | { code: number } | { asleep: boolean; reason?: string }

/** Fast commands can emit output and exit before the spawn IPC response arrives. */
export class PtyEventRouter {
  private listeners = new Map<string, Listener>()
  private pending = new Map<string, Event[]>()

  listen(id: string, listener: Listener): () => void {
    this.listeners.set(id, listener)
    const events = this.pending.get(id) ?? []
    this.pending.delete(id)
    for (const event of events) this.deliver(listener, event)
    return () => {
      this.listeners.delete(id)
      this.pending.delete(id)
    }
  }

  dispatch(id: string, event: Event): void {
    const listener = this.listeners.get(id)
    if (listener) return this.deliver(listener, event)
    const events = this.pending.get(id) ?? []
    events.push(event)
    // Bound both orphaned terminals and output buffered before registration.
    while (events.length > 128 || events.reduce((n, e) => n + ('data' in e ? e.data.length : 0), 0) > 131072) events.shift()
    this.pending.set(id, events)
    if (this.pending.size > 32) this.pending.delete(this.pending.keys().next().value!)
  }

  private deliver(listener: Listener, event: Event): void {
    if ('data' in event) listener.data(event.data)
    else if ('code' in event) listener.exit(event.code)
    else listener.state?.(event.asleep, event.reason)
  }
}
