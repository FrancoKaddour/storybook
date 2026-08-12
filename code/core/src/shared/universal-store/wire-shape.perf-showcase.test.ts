/**
 * Performance showcase: UniversalStore SET_STATE wire shape.
 *
 * Bottleneck (before): `setState` in `code/core/src/shared/universal-store/index.ts` emitted a
 * channel event whose payload was `{ state, previousState }` — i.e. TWO full copies of the store
 * state per event. `previousState` is always exactly the `state` of the previous SET_STATE frame,
 * so every receiver can derive it locally; on the wire it was pure redundancy.
 *
 * Fix: the channel frame now carries only `{ state }`. Receivers derive `previousState` from the
 * state they are about to replace, so the `onStateChange(state, previousState)` contract is
 * unchanged while the wire cost of every SET_STATE frame is halved. This showcase's assertions are
 * flipped relative to the pre-fix behavior: a frame is now ~1x the state bytes (not >= 1.95x), and
 * the wire payload no longer contains `previousState`.
 *
 * Why it matters at scale: universal stores hold monotonically growing, index-sized objects (e.g.
 * per-story status maps, one entry per story). Every small update used to re-send the entire
 * accumulated object twice, over WebSocket (server <-> manager) and postMessage (manager <->
 * preview). Removing the second copy halves all universal-store traffic. (The remaining O(N)
 * per-frame growth from re-sending the full accumulated object is a separate bottleneck, addressed
 * by the status/run delta subtask of #35431.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelTransport } from '../../channels/index.ts';
import { Channel } from '../../channels/index.ts';
import { UniversalStore } from './index.ts';
import { instances } from './instances.ts';

const makeIndexEntry = (i: number) => ({
  id: `example-component-${i}--default`,
  title: `Example/Section/Component${i}`,
  name: 'Default',
  importPath: `./src/components/section/Component${i}.stories.tsx`,
  type: 'story',
  tags: ['dev', 'test', 'autodocs'],
});

const makeStoryIndexLike = (count: number) => {
  const entries: Record<string, ReturnType<typeof makeIndexEntry>> = {};
  for (let i = 0; i < count; i += 1) {
    const entry = makeIndexEntry(i);
    entries[entry.id] = entry;
  }
  return { v: 5, entries };
};

// ~250 bytes of JSON per entry, mimicking one story's status (e.g. a11y/test results)
const makeStatusEntry = (i: number) => ({
  storyId: `example-component-${i}--default`,
  typeId: 'storybook/component-test',
  value: 'status-value:success',
  title: 'Component tests',
  description: `All assertions passed for run ${i}`.padEnd(90, '.'),
  sidebarContextMenu: false,
});

type StatusEntry = ReturnType<typeof makeStatusEntry>;

describe('UniversalStore SET_STATE wire shape (perf showcase)', () => {
  const sentFrames: any[] = [];

  const setStateFrames = () =>
    sentFrames.filter(
      (frame) => frame?.args?.[0]?.event?.type === UniversalStore.InternalEventType.SET_STATE
    );

  const frameBytes = (frame: any) => JSON.stringify(frame).length;

  beforeEach(() => {
    sentFrames.length = 0;
    const transport: ChannelTransport = {
      setHandler: vi.fn(),
      send: vi.fn((event) => {
        sentFrames.push(event);
      }),
    };
    const channel = new Channel({ transport });
    UniversalStore.__prepare(channel, UniversalStore.Environment.SERVER);

    return () => {
      instances.clear();
      UniversalStore.__reset();
    };
  });

  it('sends ~1x the state bytes in a single SET_STATE frame (state only, no second copy)', () => {
    // Arrange - a leader holding a 2,000-entry story-index-like object plus a small counter
    const store = UniversalStore.create({
      id: 'perf-showcase:redundancy',
      leader: true,
      initialState: { index: makeStoryIndexLike(2_000), counter: 0 },
    });
    sentFrames.length = 0;

    // Act - a minimal update: bump the counter, index untouched
    store.setState((current) => ({ ...current, counter: current.counter + 1 }));

    // Assert - the single frame carries the state once, not twice
    const frames = setStateFrames();
    expect(frames).toHaveLength(1);

    const stateBytes = JSON.stringify(store.getState()).length;
    const wireBytes = frameBytes(frames[0]);
    const ratio = wireBytes / stateBytes;

    expect(stateBytes).toBeGreaterThan(200_000); // sanity: the state is index-sized
    expect(ratio).toBeLessThan(1.2); // the 2x-per-event tax is gone (was >= 1.95x)

    console.log(
      `[perf-showcase] SET_STATE frame is ${(wireBytes / 1024).toFixed(0)} KB for a ` +
        `${(stateBytes / 1024).toFixed(0)} KB state (${ratio.toFixed(2)}x) — one counter bump ` +
        `sends the 2,000-entry index once`
    );
  });

  it('keeps previousState off the wire (receivers derive it locally)', () => {
    // Arrange
    const store = UniversalStore.create({
      id: 'perf-showcase:derivable',
      leader: true,
      initialState: { index: makeStoryIndexLike(50), counter: 0 },
    });
    sentFrames.length = 0;

    // Act - a sequence of updates
    for (let i = 0; i < 5; i += 1) {
      store.setState((current) => ({ ...current, counter: current.counter + 1 }));
    }

    // Assert - no SET_STATE frame carries previousState on the wire; the pre-fix payload used to
    // ship it as a second full copy. Receivers reconstruct it from the state they replace, so the
    // onStateChange(state, previousState) contract is unchanged (covered in index.test.ts).
    const payloads = setStateFrames().map((frame) => frame.args[0].event.payload);
    expect(payloads).toHaveLength(5);
    for (const payload of payloads) {
      expect(payload.state).toBeDefined();
      expect(payload).not.toHaveProperty('previousState');
    }

    console.log(
      '[perf-showcase] previousState never crosses the wire for any of the 5 frames — it is ' +
        'derived on receive'
    );
  });

  it('tracks state size (not 2x it) as state accumulates one entry per update', () => {
    // Arrange - an empty status store; each update appends one ~250-byte entry
    const store = UniversalStore.create({
      id: 'perf-showcase:accumulation',
      leader: true,
      initialState: { statuses: [] as StatusEntry[] },
    });
    sentFrames.length = 0;
    const entryBytes = JSON.stringify(makeStatusEntry(1)).length;

    // Act - 100 accumulating updates
    for (let i = 1; i <= 100; i += 1) {
      store.setState((current) => ({ statuses: [...current.statuses, makeStatusEntry(i)] }));
    }

    // Assert - each frame is ~1x its state (the redundant second copy is gone). The per-frame
    // size still grows with the accumulated state — that O(N) growth is the status/run delta
    // subtask of #35431, not this one — but it is no longer doubled.
    const frames = setStateFrames();
    expect(frames).toHaveLength(100);
    expect(entryBytes).toBeGreaterThan(200); // sanity: entries are the advertised ~250 bytes
    expect(entryBytes).toBeLessThan(320);

    const lastFrame = frames[99];
    const lastStateBytes = JSON.stringify(store.getState()).length;
    const lastRatio = frameBytes(lastFrame) / lastStateBytes;
    expect(lastRatio).toBeLessThan(1.2); // no 2x tax even at the largest accumulated state

    console.log(
      `[perf-showcase] 100 accumulating setState calls: the final frame is ` +
        `${lastRatio.toFixed(2)}x its state (was ~2x) — the redundant copy is gone`
    );
  });
});
