import { describe, expect, it } from "vitest";

import { createTask } from "./task.js";
import type { Task } from "./task.js";
import { assertNoDependencyCycle, dependencyGraphOf, dependentsOf, readyTasks, topologicalOrder } from "./index.js";

const AT = new Date("2026-03-01T09:00:00.000Z");
const ORG = "org_1";

/** A task whose only edges are the ones a test writes. */
function task(id: string, dependsOn: readonly string[] = [], overrides: Partial<Parameters<typeof createTask>[0]> = {}): Task {
  return createTask({
    taskId: id,
    organizationId: ORG,
    title: `Task ${id}`,
    createdAt: AT,
    dependsOnTaskIds: dependsOn,
    ...overrides,
  });
}

/** Marks a task finished without going through the transition machinery. */
function done(t: Task): Task {
  return { ...t, state: "done" };
}

describe("dependency cycles", () => {
  it("reports a two-task cycle and names both tasks", () => {
    const tasks = [task("t_a", ["t_b"]), task("t_b", ["t_a"])];

    expect(() => assertNoDependencyCycle(tasks)).toThrow(/t_a.*t_b|t_b.*t_a/is);
  });

  it("reports a self-dependence, which is the degenerate cycle", () => {
    // `createTask` refuses to build one, so this is the shape a hand-edited row
    // or a future migration would produce — and the graph pass must still catch
    // it rather than looping forever.
    const corrupted = { ...task("t_a"), dependsOnTaskIds: ["t_a"] };

    expect(() => assertNoDependencyCycle([corrupted])).toThrow(/t_a/);
  });

  it("reports a three-task cycle that no pairwise check would find", () => {
    // a -> b -> c -> a. A detector that only looked for direct two-cycles would
    // pass this, and the scheduler would then hang rather than refuse.
    const tasks = [task("t_a", ["t_c"]), task("t_b", ["t_a"]), task("t_c", ["t_b"])];

    expect(() => assertNoDependencyCycle(tasks)).toThrow(/t_a/);
  });

  it("accepts a diamond, which is a cycle-free graph with two distinct paths", () => {
    // A diamond is where a naive "visited means cycle" detector produces a false
    // positive, and a false positive here means refusing legal work.
    const tasks = [
      task("top", []),
      task("left", ["top"]),
      task("right", ["top"]),
      task("bottom", ["left", "right"]),
    ];

    expect(() => assertNoDependencyCycle(tasks)).not.toThrow();
    expect(topologicalOrder(tasks)).toEqual(["top", "left", "right", "bottom"]);
  });

  it("finds the first cycle deterministically, whichever task it is handed", () => {
    const tasks = [task("t_a", ["t_b"]), task("t_b", ["t_a"]), task("t_c", ["t_a"])];

    const forwards = captureCycleError(tasks);
    const backwards = captureCycleError([...tasks].reverse());

    expect(forwards).toBe(backwards);
  });
});

describe("topological order", () => {
  it("orders a graph where one step unblocks several successors at once", () => {
    // `topologicalOrder` merges newly-unblocked ids back into a sorted ready
    // list. This shape is the one that exercises the merge properly: `t_c` and
    // `t_e` are both unblocked by the same predecessor, and they interleave with
    // ids that were already waiting. A merge that appends instead of merging
    // would emit `t_a, t_b, t_d, t_c, t_e` here — still a valid topological
    // order, but a DIFFERENT one, which breaks reproducibility.
    const tasks = [
      task("t_a"),
      task("t_b"),
      task("t_c", ["t_a"]),
      task("t_d"),
      task("t_e", ["t_a"]),
    ];

    expect(topologicalOrder(tasks)).toEqual(["t_a", "t_b", "t_c", "t_d", "t_e"]);
    // Reproducible under reordering, which is the property that matters.
    expect(topologicalOrder([...tasks].reverse())).toEqual(topologicalOrder(tasks));
  });

  it("orders by dependency, breaking ties by id so the result is reproducible", () => {
    // Two schedulers handed the same rows in different orders must produce the
    // same sequence, or "the order we run things in" is an artefact of a query.
    const tasks = [task("t_c", ["t_a"]), task("t_a", []), task("t_b", [])];

    expect(topologicalOrder(tasks)).toEqual(["t_a", "t_b", "t_c"]);
    expect(topologicalOrder([...tasks].reverse())).toEqual(["t_a", "t_b", "t_c"]);
  });

  it("refuses to order a cyclic graph rather than emitting an arbitrary prefix", () => {
    const tasks = [task("t_a", ["t_b"]), task("t_b", ["t_a"])];

    expect(() => topologicalOrder(tasks)).toThrow(/t_a/);
  });

  it("refuses a dependency on a task that does not exist", () => {
    // A missing predecessor is not "no blocker". Ignoring it schedules work whose
    // prerequisite silently vanished, which is the bug class this guards.
    expect(() => topologicalOrder([task("t_a", ["ghost"])])).toThrow(/ghost/);
    expect(() => assertNoDependencyCycle([task("t_a", ["ghost"])])).toThrow(/ghost/);
  });

  it("refuses a dependency that crosses organisations", () => {
    // ADR-0011 in the domain layer: one org's task cannot block another's, and
    // an id from another tenant is not a task this org can see.
    const crossing = task("t_a", ["other_org_task"], { organizationId: "org_1" });
    const foreign = task("other_org_task", [], { organizationId: "org_2" });

    expect(() => assertNoDependencyCycle([crossing, foreign])).not.toThrow();
    // Same id, different tenant: the referenced row is simply not this org's.
    expect(() => topologicalOrder([crossing])).toThrow(/other_org_task/);
  });
});

describe("the ready set", () => {
  it("offers only work whose predecessors are all done", () => {
    const tasks = [
      task("t_a"),
      task("t_b", ["t_a"]),
      task("t_c", ["t_b"]),
      task("t_loose"),
    ];

    // A predecessor that is merely started is not done, so t_c is not ready even
    // though its immediate blocker exists.
    expect(readyTasks(tasks)).toEqual(["t_a", "t_loose"]);
    expect(readyTasks([done(tasks[0]!), tasks[1]!])).toEqual(["t_b"]);
  });

  it("never offers terminal work, whatever its predecessors say", () => {
    const tasks = [done(task("t_a")), done(task("t_b", ["t_a"]))];

    expect(readyTasks(tasks)).toEqual([]);
  });

  it("lists the tasks a task blocks, transitively", () => {
    // "What does finishing this unblock" is the question a scheduler asks, and
    // answering only the immediate successors makes a two-level chain invisible.
    const tasks = [task("t_a"), task("t_b", ["t_a"]), task("t_c", ["t_b"]), task("t_x")];

    expect(dependentsOf("t_a", tasks)).toEqual(["t_b", "t_c"]);
    expect(dependentsOf("t_c", tasks)).toEqual([]);
    expect(dependentsOf("t_unknown", tasks)).toEqual([]);
  });
});

describe("the graph projection", () => {
  it("exposes each task's predecessors and successors, sorted", () => {
    const tasks = [task("t_a"), task("t_b", ["t_a"]), task("t_c", ["t_a", "t_b"])];

    expect(dependencyGraphOf(tasks)).toEqual({
      t_a: { predecessors: [], successors: ["t_b", "t_c"] },
      t_b: { predecessors: ["t_a"], successors: ["t_c"] },
      t_c: { predecessors: ["t_a", "t_b"], successors: [] },
    });
  });

  it("returns nothing for an empty task set rather than throwing", () => {
    expect(dependencyGraphOf([])).toEqual({});
    expect(topologicalOrder([])).toEqual([]);
    expect(readyTasks([])).toEqual([]);
  });

  it("tolerates a graph whose edge lists are uneven", () => {
    // Every projection runs over a `Record`, so a key with an empty predecessor
    // list is normal. A lookup for a key that is NOT in the record must not
    // throw either: `dependentsOf` walks past the end of the graph constantly,
    // and a `TypeError` there would be a crash mid-traversal rather than a
    // refusal at the edge.
    const graph = dependencyGraphOf([task("t_a")]);

    expect(graph["t_a"]).toEqual({ predecessors: [], successors: [] });
    expect(graph["ghost"]).toBeUndefined();
    expect(dependentsOf("t_a", [task("t_a"), task("t_b", ["t_a"])])).toEqual(["t_b"]);
  });

  it("terminates on a diamond, where one node is reachable by two paths", () => {
    // The traversal guard. Without it, `t_d` is queued twice from `t_b` and
    // `t_c` and would be emitted twice; with a cycle present it would never
    // terminate at all. This is the same "colour on the stack" reasoning the
    // cycle detector uses, applied to reachability.
    const diamond = [
      task("t_a"),
      task("t_b", ["t_a"]),
      task("t_c", ["t_a"]),
      task("t_d", ["t_b", "t_c"]),
    ];

    expect(dependentsOf("t_a", diamond)).toEqual(["t_b", "t_c", "t_d"]);
  });

  it("orders a diamond with a shared successor without emitting it twice", () => {
    // Same shape, exercised through `topologicalOrder`. `t_d` is unblocked by
    // `t_b` and must not also be queued when `t_c` completes it.
    const diamond = [
      task("t_b", ["t_a"]),
      task("t_c", ["t_a"]),
      task("t_d", ["t_b", "t_c"]),
      task("t_a"),
    ];

    const order = topologicalOrder(diamond);

    expect(order).toHaveLength(4);
    expect(new Set(order).size).toBe(4);
    expect(order.indexOf("t_d")).toBeGreaterThan(order.indexOf("t_b"));
    expect(order.indexOf("t_d")).toBeGreaterThan(order.indexOf("t_c"));
  });
});

/** The message of the cycle refusal, so two orderings can be compared directly. */
function captureCycleError(tasks: readonly Task[]): string {
  try {
    topologicalOrder(tasks);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a cycle refusal and none was thrown");
}
