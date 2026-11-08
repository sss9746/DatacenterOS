import { describe, expect, it } from 'vitest';
import { createDeliveryWatchdog } from '../src/watchdog.js';

function setup() {
  let t = 1_000;
  return { dog: createDeliveryWatchdog(20_000, () => t), advance: (ms: number) => (t += ms) };
}

describe('createDeliveryWatchdog', () => {
  it('does not expire while nothing has been sent, however long the gap', () => {
    const { dog, advance } = setup();
    advance(600_000);
    expect(dog.expired()).toBe(false);
  });

  it('stays healthy while batches are delivered', () => {
    const { dog, advance } = setup();
    for (let i = 0; i < 60; i++) {
      const id = dog.sent();
      advance(1_000);
      dog.delivered(id);
    }
    expect(dog.expired()).toBe(false);
  });

  it('expires when batches keep going out and none is delivered', () => {
    const { dog, advance } = setup();
    for (let i = 0; i < 21; i++) {
      dog.sent();
      advance(1_000);
    }
    expect(dog.expired()).toBe(true);
  });

  it('measures from the oldest undelivered batch, not the newest', () => {
    const { dog, advance } = setup();
    dog.sent();
    advance(19_000);
    dog.sent();
    advance(2_000);
    expect(dog.expired()).toBe(true);
  });

  it('counts a long SSH gap only from the first batch after it', () => {
    const { dog, advance } = setup();
    dog.delivered(dog.sent());
    advance(120_000);
    dog.sent();
    expect(dog.expired()).toBe(false);
  });

  it('keeps tracking a newer batch when an older overlapping one is delivered', () => {
    const { dog, advance } = setup();
    const older = dog.sent();
    advance(1_000);
    dog.sent();
    dog.delivered(older);
    advance(20_001);
    expect(dog.expired()).toBe(true);
  });

  it('a later delivery settles an older batch that was rejected', () => {
    const { dog, advance } = setup();
    dog.sent();
    advance(1_000);
    const later = dog.sent();
    dog.delivered(later);
    advance(60_000);
    expect(dog.expired()).toBe(false);
  });
});
