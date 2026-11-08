// The DB client does not reconnect, so a dropped socket would leave the collector running with nothing
// arriving. This notices batches that were sent and never delivered, so the process can exit and be
// restarted. A quiet period with nothing to send (SSH reconnecting) never counts.
export interface DeliveryWatchdog {
  /** Records a send and returns its id. */
  sent(): number;
  /** A delivered batch also settles every older one; newer sends stay tracked. */
  delivered(id: number): void;
  expired(): boolean;
}

export function createDeliveryWatchdog(limitMs: number, now: () => number = Date.now): DeliveryWatchdog {
  let nextId = 0;
  const pending = new Map<number, number>(); // id -> send time, oldest first
  return {
    sent() {
      const id = nextId++;
      pending.set(id, now());
      return id;
    },
    delivered(id) {
      for (const sentId of pending.keys()) {
        if (sentId <= id) pending.delete(sentId);
      }
    },
    expired() {
      const oldest = pending.values().next().value;
      return oldest !== undefined && now() - oldest > limitMs;
    },
  };
}
