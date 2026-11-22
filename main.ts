import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type Push = { box: number; dir: number };
type Board = { w: number; floor: Set<number>; goals: number[]; boxes: number[]; player: number };
type Room = { cells: Set<number>; entry: number; goals: number[]; boxes: number[] };
type State = { boxes: number[]; player: number; g: number; h: number; f: number; order: number; key: string; parent: State | null; push: Push | null };
const letters = ['u', 'd', 'l', 'r'];
const deadline = Date.now() + 50000;
function parse(text: string): Board {
  const rows = text.replace(/\r/g, '').split('\n');
  const w = Math.max(...rows.map(r => r.length));
  const floor = new Set<number>(), goals: number[] = [], boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    const p = y * w + x;
    if (' .*$@+-_'.includes(c)) floor.add(p);
    if ('.*+'.includes(c)) goals.push(p);
    if ('$*'.includes(c)) boxes.push(p);
    if ('@+'.includes(c)) player = p;
  }));
  if (player < 0) throw new Error('Missing player');
  return { w, floor, goals, boxes, player };
}
function neighbors(p: number, w: number): number[] {
  return [p - w, p + w, p % w ? p - 1 : -1, p % w < w - 1 ? p + 1 : -1];
}
function decompose(b: Board): Room[] | null {
  const row = Math.floor(b.player / b.w), seen = new Set<number>(), rooms: Room[] = [];
  for (const p of b.floor) {
    if (Math.floor(p / b.w) === row || seen.has(p)) continue;
    const cells = new Set<number>([p]), queue = [p]; seen.add(p);
    for (let i = 0; i < queue.length; i++) for (const q of neighbors(queue[i], b.w)) {
      if (b.floor.has(q) && Math.floor(q / b.w) !== row && !seen.has(q)) {
        seen.add(q); cells.add(q); queue.push(q);
      }
    }
    const entries: number[] = [];
    for (const c of cells) for (const q of [c - b.w, c + b.w]) {
      if (Math.floor(q / b.w) === row && b.floor.has(q)) entries.push(q);
    }
    if (entries.length !== 1) return null;
    const goals = b.goals.filter(g => cells.has(g)), boxes = b.boxes.filter(c => cells.has(c));
    if (goals.length !== boxes.length) return null;
    rooms.push({ cells, entry: entries[0], goals, boxes });
  }
  if (b.boxes.some(p => !seen.has(p)) || b.goals.some(p => !seen.has(p))) return null;
  if (new Set(rooms.map(r => r.entry)).size !== rooms.length) return null;
  return rooms.sort((a, c) => a.entry % b.w - c.entry % b.w);
}
class Heap {
  a: State[] = [];
  less(a: State, b: State): boolean { return a.f < b.f || (a.f === b.f && (a.h < b.h || (a.h === b.h && a.order < b.order))); }
  put(s: State) {
    let i = this.a.length; this.a.push(s);
    while (i) { const p = (i - 1) >> 1; if (!this.less(s, this.a[p])) break; this.a[i] = this.a[p]; i = p; }
    this.a[i] = s;
  }
  pop(): State {
    const root = this.a[0], last = this.a.pop()!;
    if (this.a.length) {
      let i = 0;
      while (i * 2 + 1 < this.a.length) {
        let j = i * 2 + 1;
        if (j + 1 < this.a.length && this.less(this.a[j + 1], this.a[j])) j++;
        if (!this.less(this.a[j], last)) break;
        this.a[i] = this.a[j]; i = j;
      }
      this.a[i] = last;
    }
    return root;
  }
}
function solve(b: Board, r: Room, exit: boolean, weight: number): Push[] | null {
  // Dense local indices keep flood fills and occupancy arrays small.
  const cells = [...r.cells].sort((a, c) => a - c);
  const allowed = [...cells]; if (!r.cells.has(r.entry)) allowed.push(r.entry);
  const index = new Map(allowed.map((p, i) => [p, i]));
  const n = allowed.length, boxN = cells.length, entry = index.get(r.entry)!;
  const adj = allowed.map(p => neighbors(p, b.w).map(q => index.get(q) ?? -1));
  const goals = r.goals.map(p => index.get(p)!);
  const goalSet = new Set(goals);
  const distances = goals.map(g => {
    const dist = new Int32Array(n).fill(1000000), queue = [g]; dist[g] = 0;
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      for (let d = 0; d < 4; d++) {
        const prev = adj[c][d];
        if (prev < 0 || prev >= boxN) continue;
        const stand = adj[prev][d];
        if (stand >= 0 && dist[prev] === 1000000) { dist[prev] = dist[c] + 1; queue.push(prev); }
      }
    }
    return dist;
  });
  const dead = allowed.map((_, c) => !distances.some(dist => dist[c] < 1000000));
  const hcache = new Map<string, number>();
  function heuristic(boxes: number[]): number {
    const key = boxes.join(','); const cached = hcache.get(key); if (cached !== undefined) return cached;
    // Subset assignment DP also supports the larger whole-board fallback.
    const memo = new Map<number, number>();
    function assign(i: number, mask: number): number {
      if (i === boxes.length) return 0;
      const old = memo.get(mask); if (old !== undefined) return old;
      let best = 1000000;
      for (let j = 0; j < goals.length; j++) if (!(mask & (1 << j))) best = Math.min(best, distances[j][boxes[i]] + assign(i + 1, mask | (1 << j)));
      memo.set(mask, best); return best;
    }
    const h = assign(0, 0); hcache.set(key, h); return h;
  }
  const occupied = new Uint8Array(n), reached = new Uint8Array(n), queue = new Int32Array(n);
  function region(boxes: number[], player: number): number {
    occupied.fill(0); for (const c of boxes) occupied[c] = 1;
    reached.fill(0); reached[player] = 1; queue[0] = player;
    let end = 1, min = player;
    for (let i = 0; i < end; i++) for (const q of adj[queue[i]]) if (q >= 0 && !occupied[q] && !reached[q]) {
      reached[q] = 1; queue[end++] = q; if (allowed[q] < allowed[min]) min = q;
    }
    return min;
  }
  const heap = new Heap(), best = new Map<string, number>(); let serial = 0;
  function add(boxes: number[], player: number, g: number, parent: State | null, push: Push | null) {
    const rep = region(boxes, player), key = boxes.join(',') + ':' + rep;
    if ((best.get(key) ?? Infinity) <= g) return;
    const h = heuristic(boxes); if (h >= 1000000) return;
    best.set(key, g); heap.put({ boxes, player: rep, g, h, f: g + weight * h, order: serial++, key, parent, push });
  }
  add(r.boxes.map(p => index.get(p)!).sort((a, c) => a - c), entry, 0, null, null);
  let expanded = 0;
  while (heap.a.length) {
    const state = heap.pop(); if (best.get(state.key) !== state.g) continue;
    region(state.boxes, state.player);
    if (state.boxes.every(c => goalSet.has(c)) && (!exit || reached[entry])) {
      const result: Push[] = []; let s = state;
      while (s.parent) { result.push(s.push!); s = s.parent; }
      return result.reverse();
    }
    if (++expanded > 2000000 || ((expanded & 1023) === 0 && Date.now() > (weight === 1 ? deadline : deadline + 7000))) return null;
    // Save legal pushes before add() reuses the flood-fill buffers.
    const moves: { i: number; d: number; t: number }[] = [];
    state.boxes.forEach((c, i) => {
      for (let d = 0; d < 4; d++) {
        const t = adj[c][d], stand = adj[c][d ^ 1];
        if (t >= 0 && t < boxN && !dead[t] && !occupied[t] && stand >= 0 && reached[stand]) moves.push({ i, d, t });
      }
    });
    for (const { i, d, t } of moves) {
      const boxes = state.boxes.slice(), old = boxes[i]; boxes[i] = t; boxes.sort((a, c) => a - c);
      add(boxes, old, state.g + 1, state, { box: allowed[old], dir: d });
    }
  }
  return null;
}
function solution(b: Board): string {
  const rooms = decompose(b);
  const tasks = rooms ?? [{ cells: b.floor, entry: b.player, boxes: b.boxes, goals: b.goals }];
  const boxes = new Set(b.boxes); let player = b.player, output = '';
  function walk(target: number) {
    const queue = [player], prev = new Map<number, { p: number; d: number }>(); prev.set(player, { p: -1, d: -1 });
    for (let i = 0; i < queue.length && !prev.has(target); i++) neighbors(queue[i], b.w).forEach((q, d) => {
      if (b.floor.has(q) && !boxes.has(q) && !prev.has(q)) { prev.set(q, { p: queue[i], d }); queue.push(q); }
    });
    if (!prev.has(target)) throw new Error('Unreachable walk target');
    const path: string[] = []; let p = target;
    while (p !== player) { const step = prev.get(p)!; path.push(letters[step.d]); p = step.p; }
    output += path.reverse().join(''); player = target;
  }
  for (const r of tasks) {
    const pushes = solve(b, r, rooms !== null, 1) ?? solve(b, r, rooms !== null, 2);
    if (!pushes) throw new Error('Search exhausted');
    walk(r.entry);
    for (const push of pushes) {
      const target = neighbors(push.box, b.w)[push.dir], stand = neighbors(push.box, b.w)[push.dir ^ 1];
      walk(stand);
      if (!boxes.has(push.box) || boxes.has(target) || !b.floor.has(target)) throw new Error('Illegal push');
      output += letters[push.dir]; boxes.delete(push.box); boxes.add(target); player = push.box;
    }
  }
  if ([...boxes].some(p => !b.goals.includes(p))) throw new Error('Unsolved');
  return output;
}
const input = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const output = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(input, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
  const moves = solution(parse(readFileSync(join(input, id, 'level.txt'), 'utf8')));
  mkdirSync(join(output, id), { recursive: true });
  writeFileSync(join(output, id, 'solution.txt'), moves + '\n');
}
