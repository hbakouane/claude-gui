// What changed between two snapshots from `activeSessions`, as notifications: a session that started waiting for
// an answer, or a turn that finished. A session missing from `previous` counts as idle, so one that appears and
// immediately asks a question is still reported.
export function sessionChanges(previous, current) {
  const events = [];
  for (const [key, now] of current) {
    const before = previous.get(key) ?? { turnOpen: false, waitingFor: null };
    const base = { projectId: now.projectId, sessionId: now.sessionId, title: now.title };
    if (now.waitingFor && now.waitingFor.kind !== before.waitingFor?.kind) {
      events.push({ ...base, type: now.waitingFor.kind, detail: now.waitingFor.text });
    } else if (before.turnOpen && !now.turnOpen) {
      events.push({ ...base, type: 'finished', detail: now.lastReply });
    }
  }

  return events;
}

// Scans while at least one browser is listening, and sends each change to every listener.
export function createNotifier({ scan, intervalMs }) {
  const listeners = new Set();
  let snapshot = null;
  let timer = null;
  let scanning = false;

  async function poll() {
    if (scanning) {
      return;
    }
    scanning = true;
    try {
      const next = await scan();
      const events = snapshot ? sessionChanges(snapshot, next) : [];
      snapshot = next;
      for (const event of events) {
        listeners.forEach((listener) => listener(event));
      }
    } catch {
      // A failed scan keeps the last snapshot and tries again on the next tick.
    } finally {
      scanning = false;
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!timer) {
        timer = setInterval(poll, intervalMs);
        timer.unref?.();
        poll();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearInterval(timer);
          timer = null;
          snapshot = null;
        }
      };
    },
    poll,
  };
}
