import type { TraceabilityDocument } from "@system-design-team/core";

export type TraceNode = TraceabilityDocument["nodes"][number];
export type TraceLink = TraceabilityDocument["links"][number];

export interface TraceabilityFinding {
  code: "REQUIREMENT_WITHOUT_TEST";
  nodeId: string;
  message: string;
}

export interface Coverage {
  total: number;
  covered: number;
  percentage: number;
}

function requirementCoverage(nodes: readonly TraceNode[], links: readonly TraceLink[]) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const requirements = nodes
    .filter((node) => node.kind === "requirement" && node.status === "approved")
    .map((node) => node.id)
    .sort();
  const covered = new Set(links
    .filter((link) => link.type === "verified_by")
    .filter((link) => {
      const test = nodesById.get(link.to);
      return test?.kind === "test" && test.status !== "stale" && test.status !== "superseded";
    })
    .map((link) => link.from));
  return { requirements, covered };
}

export function validateTraceability(
  nodes: readonly TraceNode[],
  links: readonly TraceLink[],
): TraceabilityFinding[] {
  const { requirements, covered } = requirementCoverage(nodes, links);
  return requirements
    .filter((id) => !covered.has(id))
    .map((id) => ({
      code: "REQUIREMENT_WITHOUT_TEST",
      nodeId: id,
      message: `Approved requirement ${id} has no current test`,
    }));
}

export function traceCoverage(nodes: readonly TraceNode[], links: readonly TraceLink[]): Coverage {
  const { requirements, covered } = requirementCoverage(nodes, links);
  const count = requirements.filter((id) => covered.has(id)).length;
  return {
    total: requirements.length,
    covered: count,
    percentage: requirements.length === 0 ? 100 : (count / requirements.length) * 100,
  };
}

export function propagateStaleness(
  changedIds: readonly string[],
  links: readonly TraceLink[],
): Set<string> {
  const changed = new Set(changedIds);
  const hardDependencies = new Map<string, string[]>();
  for (const link of links) {
    if (link.type !== "hard_dependency") continue;
    const targets = hardDependencies.get(link.from) ?? [];
    targets.push(link.to);
    hardDependencies.set(link.from, targets);
  }
  for (const targets of hardDependencies.values()) targets.sort();

  const stale = new Set<string>();
  const visited = new Set(changed);
  const queue = [...changed].sort();
  for (let index = 0; index < queue.length; index += 1) {
    for (const target of hardDependencies.get(queue[index]!) ?? []) {
      if (visited.has(target)) continue;
      visited.add(target);
      stale.add(target);
      queue.push(target);
    }
  }

  for (const link of links) {
    if (link.type === "derived_from" && changed.has(link.from) && !changed.has(link.to)) {
      stale.add(link.to);
    }
  }
  return new Set([...stale].sort());
}
