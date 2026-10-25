'use client';

import { animate, createMotionPath, createTimeline, stagger, utils, type JSAnimation } from 'animejs';
import { useEffect, useRef, type RefObject } from 'react';

// Every Anime.js call lives in this folder (D56). React always renders the final value first; these hooks only
// animate from the previous value towards it, so the DOM is correct before an animation starts and after it ends.

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Counts the text inside `ref` from the last shown value to `value`. The element's only child must be the text React
// renders as format(value); the hook rewrites that same text node, so React keeps ownership of it.
export function useCountUp(ref: RefObject<HTMLElement | null>, value: number, format: (n: number) => string): void {
  const shown = useRef(0); // the first load counts up from zero
  const fmt = useRef(format);
  fmt.current = format;

  useEffect(() => {
    const node = ref.current?.firstChild;
    const from = shown.current;
    if (!node || node.nodeType !== Node.TEXT_NODE || prefersReducedMotion() || from === value) {
      shown.current = value;
      return;
    }
    const state = { n: from };
    const anim: JSAnimation = animate(state, {
      n: value,
      duration: 700,
      ease: 'outCubic',
      onUpdate: () => {
        shown.current = state.n;
        node.nodeValue = fmt.current(state.n);
      },
      onComplete: () => {
        shown.current = value;
        node.nodeValue = fmt.current(value);
      },
    });
    // A new value cancels this one; React has already written the new text, and the next run starts from here.
    return () => {
      anim.cancel();
    };
  }, [ref, value]);
}

// Grows a bar's width from its previous fraction to `fraction` (0..1). React renders the final width as a style.
export function useBarGrowth(ref: RefObject<HTMLElement | null>, fraction: number): void {
  const prev = useRef(0);
  useEffect(() => {
    const el = ref.current;
    const from = prev.current;
    prev.current = fraction;
    if (!el || prefersReducedMotion() || from === fraction) return;
    const anim = animate(el, {
      width: [`${from * 100}%`, `${fraction * 100}%`],
      duration: 600,
      ease: 'outCubic',
    });
    return () => {
      anim.complete(true);
    };
  }, [ref, fraction]);
}

// Staggered entrance of the children matching `selector` when the container mounts, and again whenever `key`
// changes (new rows of a feed). The whole stagger stays under 600 ms however many items there are.
export function useEntrance(ref: RefObject<HTMLElement | null>, selector: string, key?: unknown): void {
  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLElement>(selector);
    if (!items || items.length === 0 || prefersReducedMotion()) return;
    const anim = animate(items, {
      opacity: [0, 1],
      translateY: [8, 0],
      delay: stagger(Math.min(45, 600 / items.length)),
      duration: 380,
      ease: 'outQuad',
    });
    return () => {
      anim.complete(true);
    };
  }, [ref, selector, key]);
}

// A short fade when `key` changes (a new day on the slider), so the change is visible without hiding data.
export function useFlash(ref: RefObject<HTMLElement | SVGElement | null>, key: unknown): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const anim = animate(el, { opacity: [0.55, 1], duration: 260, ease: 'outQuad' });
    return () => {
      anim.complete(true);
    };
  }, [ref, key]);
}

// The journey: each arrow fades in, its count pops, and a dot travels along the arrow from stage to stage.
// Arrows are `[data-arrow=k]` paths, dots `[data-dot=k]`, labels `[data-label=k]`, all inside `ref`.
export function useJourneyPlay(ref: RefObject<SVGSVGElement | null>, playKey: number | null): void {
  useEffect(() => {
    const svg = ref.current;
    if (!svg || playKey === null || prefersReducedMotion()) return;
    const anims: JSAnimation[] = [];
    svg.querySelectorAll<SVGPathElement>('path[data-arrow]').forEach((path, i) => {
      const k = path.dataset.arrow ?? '';
      const delay = i * 140;
      anims.push(animate(path, { opacity: [0, 1], duration: 300, delay, ease: 'outQuad' }));
      const label = svg.querySelector(`[data-label="${k}"]`);
      if (label) anims.push(animate(label, { opacity: [0, 1], scale: [0.6, 1], duration: 360, delay: delay + 650 }));
      const dot = svg.querySelector(`[data-dot="${k}"]`);
      if (dot) {
        anims.push(
          animate(dot, {
            ...createMotionPath(path),
            opacity: [
              { to: 1, duration: 120 },
              { to: 1, duration: 660 },
              { to: 0, duration: 120 },
            ],
            duration: 900,
            delay,
            ease: 'inOutSine',
          }),
        );
      }
    });
    // Cut short (unmount, or the next advance): jump to the end, so every arrow and count is fully shown.
    return () => {
      for (const a of anims) a.complete(true);
    };
  }, [ref, playKey]);
}

// T22b. The mailbox tiles: each `[data-grow]` fill grows up from zero with a short stagger when `playKey` changes.
// React renders the final heights; only a transform is animated, so the end state is exactly what React drew.
export function useFillGrow(ref: RefObject<HTMLElement | null>, playKey: number | null): void {
  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLElement>('[data-grow]');
    if (playKey === null || !items || items.length === 0 || prefersReducedMotion()) return;
    const anim = animate(items, {
      scaleY: [0, 1],
      delay: stagger(Math.min(18, 500 / items.length)),
      duration: 520,
      ease: 'outCubic',
    });
    return () => {
      anim.complete(true);
    };
  }, [ref, playKey]);
}

// T22b. The send strip's play (D71): a playhead sweeps the 24 UTC hours in `sweepMs`; as it reaches an hour, that
// hour's dots fly from the mailbox bank into their cells; bounced ones turn red, drop and fade to 40%.
// Dots are `circle[data-dot]` with data-hour, data-cx, data-cy (their place in the cell) and, when bounced,
// data-drop. React renders every dot at its final place, so a cut-short play (complete) ends on the same picture.
// The bank point is the svg's data-bank-x / data-bank-y; the playhead is `line[data-playhead]` from data-x0 to data-x1.
export const STRIP_SWEEP_MS = 2400;
const num = (el: unknown, key: string) => Number((el as SVGElement).dataset[key]);
export function useStripPlay(
  ref: RefObject<SVGSVGElement | null>,
  playKey: number | null,
  colors: { sent: string; bounced: string },
): void {
  const palette = useRef(colors);
  palette.current = colors;
  useEffect(() => {
    const svg = ref.current;
    if (!svg || playKey === null || prefersReducedMotion()) return;
    const bankX = Number(svg.dataset.bankX);
    const bankY = Number(svg.dataset.bankY);
    const hourMs = STRIP_SWEEP_MS / 24;
    const tl = createTimeline({ autoplay: true });

    const head = svg.querySelector<SVGLineElement>('line[data-playhead]');
    if (head) {
      const x0 = Number(head.dataset.x0);
      const x1 = Number(head.dataset.x1);
      // On the clock's own day the head stops at the clock (data-hours < 24), keeping the same pace per hour.
      const sweep = (Number(head.dataset.hours) || 24) * hourMs;
      utils.set(head, { x1: x0, x2: x0, opacity: 1 });
      tl.add(head, { x1: [x0, x1], x2: [x0, x1], duration: sweep, ease: 'linear' }, 0);
      tl.add(head, { opacity: [1, 0], duration: 300, ease: 'outQuad' }, sweep);
    }

    const dots = Array.from(svg.querySelectorAll<SVGCircleElement>('circle[data-dot]'));
    if (dots.length > 0) utils.set(dots, { cx: bankX, cy: bankY, opacity: 0, fill: palette.current.sent });
    const byHour = new Map<number, SVGCircleElement[]>();
    for (const d of dots) {
      const h = Number(d.dataset.hour);
      byHour.set(h, [...(byHour.get(h) ?? []), d]);
    }
    for (const [hour, group] of byHour) {
      const at = hour * hourMs;
      const step = Math.min(18, 160 / group.length);
      tl.add(
        group,
        {
          // From the bank, where utils.set put every dot, to the dot's place in its cell.
          cx: (el?: unknown) => num(el, 'cx'),
          cy: (el?: unknown) => num(el, 'cy'),
          opacity: 1,
          delay: stagger(step),
          duration: 460,
          ease: 'outCubic',
        },
        at,
      );
      const bounced = group.filter((d) => d.dataset.drop !== undefined);
      if (bounced.length === 0) continue;
      const landed = at + 460 + step * group.length;
      tl.add(bounced, { fill: [palette.current.sent, palette.current.bounced], duration: 160 }, landed);
      tl.add(
        bounced,
        {
          cy: (el?: unknown) => num(el, 'cy') + num(el, 'drop'),
          opacity: 0.4,
          duration: 340,
          ease: 'inQuad',
        },
        landed + 180,
      );
    }
    // Cut short (new data, a new play, unmount): jump to the end, so every dot sits where React drew it.
    return () => {
      tl.complete(true);
    };
  }, [ref, playKey]);
}
