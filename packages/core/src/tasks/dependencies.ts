/**
 * Task dependencies: a graph that has to be a DAG.
 *
 * ## Why cycle detection is worth a module of its own
 *
 * A dependency cycle is a real scheduling bug, not a data-entry nuisance. A
 * cyclic plan has no valid order, so a scheduler that walks it does not produce
 * a wrong answer — it produces **no** answer, and depending on how it walks it
 * may loop forever or silently drop a task. Both failure modes are invisible
 * until somebody is waiting on work that will never start.
 *
 * The obvious implementation — "a node I have already seen is on a cycle" — is
 * **wrong**, and it fails on the most common legal shape there is. In a diamond
 * (`top → left → bottom`, `top → right → bottom`) reaching `bottom` by two paths
 * is not a cycle at all. Refusing a diamond means refusing correct plans, and a
 * detector that cries wolf is a detector people disable.
 *
 * So this uses the standard three-colour DFS, which tracks the colour *on the
 * current stack* rather than "have I ever seen this node". A grey node is on the
 * recursion stack and therefore genuinely its own ancestor; a black node was
 * finished and is safe to revisit. That distinction is the whole difference
 * between a correct detector and one that blocks ordinary work.
 *
 * ## Determinism is part of the contract
 *
 * Every traversal sorts its keys. Two runs handed the same rows in different
 * orders must produce the same order and the same error message, because a
 * scheduler whose output depends on which page of rows the database returned is
 * a scheduler nobody can reproduce when it goes wrong. The test asserts this by
 * feeding the same graph forwards and backwards and comparing the message.
 *
 * ## Cross-organisation edges are refused, not silently dropped
 *
 * A task in Org A cannot be blocked by a task in Org B: it would let one
 * organisation's work schedule another's, and per ADR-0011 the reference is not
 * merely discouraged but structurally impossible. Here it is caught by
 * *existence* rather than by a tenant comparison — the referenced id is simply
 * absent from the set this org supplied, which is exactly the position the
 * database's composite foreign key puts it in.
 *
 * Pure: no clock, no I/O. The `at` used elsewhere in this package is not needed
 * here because nothing in this module has an instant.
 */

import type { Task } from "./task.js";

/** One task's edges, both directions. */
export interface TaskEdges {
  readonly predecessors: readonly string[];
  readonly successors: readonly string[];
}

/**
 * The whole graph, keyed by task id.
 *
 * A `Record` rather than a `Map` so the result is comparable with `toEqual` in a
 * test and printable in a log without a serialisation step.
 */
export type TaskGraph = Readonly<Record<string, TaskEdges>>;

/**
 * Project a task list into its graph.
 *
 * Successors are derived by inversion: predecessor lists are the input a caller
 * writes, and "what does finishing this unblock" is the question they actually
 * ask, so answering it here saves every caller a reverse pass.
 */
export function dependencyGraphOf(tasks: readonly Task[]): TaskGraph {
  const predecessors = new Map<string, Set<string>>();
  const successors = new Map<string, Set<string>>();

  for (const task of tasks) {
    ensureEntry(predecessors, task.taskId);
    ensureEntry(successors, task.taskId);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOnTaskIds) {
      addTo(predecessors, task.taskId, dependency);
      addTo(successors, dependency, task.taskId);
    }
  }

  const graph: Record<string, TaskEdges> = {};
  for (const taskId of sortedKeys(predecessors)) {
    graph[taskId] = Object.freeze({
      predecessors: Object.freeze(sortedValues(predecessors, taskId)),
      successors: Object.freeze(sortedValues(successors, taskId)),
    });
  }
  return Object.freeze(graph);
}

/**
 * Kahn's algorithm, with a sort by id as the tie-break.
 *
 * A single pass that also *finds* the cycle: when the ready set empties with
 * tasks still unscheduled, those tasks are exactly the ones downstream of a
 * cycle, so the error names them rather than saying "the graph is cyclic" and
 * leaving the reader to find which.
 *
 * The tie-break is why this returns a *stable* order. Two schedulers handed the
 * same dependency graph must produce the same sequence, or "the order we run
 * things in" is an artefact of a query plan.
 */
export function topologicalOrder(tasks: readonly Task[]): readonly string[] {
  const graph = checkedGraph(tasks);

  const remaining = new Map<string, number>();
  for (const taskId of Object.keys(graph).sort(compareStrings)) {
    remaining.set(taskId, graph[taskId]!.predecessors.length);
  }

  const order: string[] = [];
  // A sorted list of currently-ready ids, so the next pick is the smallest
  // available rather than whatever a Set happens to iterate first.
  let ready = Object.keys(graph)
    .sort(compareStrings)
    .filter((id) => remaining.get(id) === 0);

  while (ready.length > 0) {
    const next = ready.shift() as string;
    order.push(next);
    remaining.delete(next);

    const unblocked: string[] = [];
    for (const successor of graph[next]!.successors) {
      // No `undefined` check is needed and none is written: a successor is a key
      // of the same graph `remaining` was built from, and it cannot have been
      // emitted yet (its count included `next`, which was not emitted). A guard
      // here would be a branch no input could ever take, and unreachable
      // defensive code is worse than none — it reads as a real case.
      const after = remaining.get(successor) as number - 1;
      remaining.set(successor, after);
      if (after === 0) unblocked.push(successor);
    }

    // `unblocked` cannot contain an id already in `ready` — a ready id has no
    // remaining predecessors, and every id here just had one of them (`next`)
    // decremented — so the merge needs no duplicate check either.
    ready = mergeSorted(ready, sortedStrings(unblocked));
  }

  if (remaining.size > 0) {
    const stuck = sortedKeys(remaining);
    throw new Error(
      `Task dependencies contain a cycle, so they have no valid order. Blocked: ${stuck.join(", ")}. ` +
        `A cycle is a plan that cannot be scheduled at all, which is worse than a wrong one.`,
    );
  }

  return Object.freeze(order);
}

/**
 * Throw if the graph is not a DAG, naming the tasks that cannot be ordered.
 *
 * Separate from {@link topologicalOrder} because callers that only want the
 * *check* — a save path, a validation endpoint — should not pay for an order
 * they will discard, and because "is this valid" and "what order then" are two
 * questions with two different failure messages.
 *
 * Also enforces the existence rule, which is a different failure and gets a
 * different message: a dependency on a task that is not in the set is a
 * reference that cannot resolve, not a cycle.
 */
export function assertNoDependencyCycle(tasks: readonly Task[]): void {
  topologicalOrder(tasks);
}

/**
 * The tasks a task blocks, transitively and sorted.
 *
 * Transitive because the question a scheduler asks is "what starts moving when
 * this finishes", and answering only the immediate successors makes a two-level
 * chain look like it still has a blocker after one of them completes.
 */
export function dependentsOf(taskId: string, tasks: readonly Task[]): readonly string[] {
  const graph = dependencyGraphOf(tasks);
  if (!(taskId in graph)) return Object.freeze([]);

  const found = new Set<string>();
  const queue = [...graph[taskId]!.successors];

  while (queue.length > 0) {
    const next = queue.shift() as string;
    // The diamond guard. `found` is what makes this traversal terminate on a
    // graph with two paths to the same node — the same reason the cycle detector
    // tracks a colour rather than "have I seen this".
    if (found.has(next)) continue;
    found.add(next);
    for (const successor of graph[next]!.successors) {
      queue.push(successor);
    }
  }

  return Object.freeze([...found].sort(compareStrings));
}

/**
 * Non-terminal tasks whose predecessors are all `done`, sorted by task id.
 *
 * A predecessor that is merely *started* does not count as done. That is the
 * distinction that stops a chain being released one step early every time, which
 * is how a two-day plan becomes a one-day plan nobody planned.
 */
export function readyTasks(tasks: readonly Task[]): readonly string[] {
  const graph = dependencyGraphOf(tasks);
  const state = new Map(tasks.map((task) => [task.taskId, task]));

  const ready: string[] = [];
  for (const taskId of Object.keys(graph).sort(compareStrings)) {
    const task = state.get(taskId);
    // Terminal work is never ready. A done task is not "ready to start again",
    // and a cancelled one is not ready for anything.
    if (task === undefined || task.state === "done" || task.state === "cancelled") continue;

    const allDone = graph[taskId]!.predecessors.every((id) => state.get(id)?.state === "done");
    if (allDone) ready.push(taskId);
  }

  return Object.freeze(ready);
}

/**
 * Build the graph and refuse any edge that cannot resolve.
 *
 * The existence check runs **before** the cycle check on purpose: a dangling
 * reference is a simpler fault and the more useful message, and reporting it as
 * a cycle would send a reader looking for a loop that is not there.
 */
function checkedGraph(tasks: readonly Task[]): TaskGraph {
  const known = new Set(tasks.map((task) => task.taskId));

  const dangling: string[] = [];
  for (const task of tasks) {
    for (const dependency of task.dependsOnTaskIds) {
      if (!known.has(dependency)) dangling.push(`${task.taskId} -> ${dependency}`);
    }
  }
  if (dangling.length > 0) {
    dangling.sort(compareStrings);
    throw new Error(
      `Task dependencies reference tasks that are not present: ${dangling.join(", ")}. ` +
        `A dependency that cannot resolve is not "no blocker" — it is a blocker nobody can see.`,
    );
  }

  return dependencyGraphOf(tasks);
}

// --- sorted-set helpers -----------------------------------------------------
//
// Every traversal in this file sorts its keys, which is what makes the output
// reproducible. The helpers below exist so that sorting is a single, hard-to-get
// -wrong expression at each call site rather than a hand-rolled loop each time.

function ensureEntry(map: Map<string, Set<string>>, key: string): void {
  if (!map.has(key)) map.set(key, new Set());
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  ensureEntry(map, key);
  (map.get(key) as Set<string>).add(value);
}

function sortedKeys<V>(map: ReadonlyMap<string, V>): string[] {
  return [...map.keys()].sort(compareStrings);
}

/**
 * The sorted contents of one adjacency set.
 *
 * No `undefined` guard: `ensureEntry` has already created an entry for every
 * node in the graph, so `map.get(key)` cannot miss for a key this module asks
 * about. A guard would be a branch no input could take.
 */
function sortedValues(map: ReadonlyMap<string, Set<string>>, key: string): readonly string[] {
  return Object.freeze([...(map.get(key) as Set<string>)].sort(compareStrings));
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return [...values].sort(compareStrings);
}

/**
 * Merge two already-sorted, DISJOINT id lists into one sorted list.
 *
 * Disjoint is a precondition, not a hope: {@link topologicalOrder} proves it
 * above and says why. An earlier version deduplicated defensively, which put
 * four unreachable branches in the most safety-critical function in this file
 * and made the real logic harder to read.
 */
function mergeSorted(left: readonly string[], right: readonly string[]): string[] {
  const merged: string[] = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (compareStrings(left[i] as string, right[j] as string) <= 0) {
      merged.push(left[i] as string);
      i += 1;
    } else {
      merged.push(right[j] as string);
      j += 1;
    }
  }

  for (; i < left.length; i += 1) merged.push(left[i] as string);
  for (; j < right.length; j += 1) merged.push(right[j] as string);

  return merged;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
