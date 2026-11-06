export interface BranchNode { id: string; parent_id?: string | null; parent_ids?: string[] }

/** Selected node, its complete canonical ancestry and its entire descendant tree.
 * Ancestors do not expand into their other branches. Cycles cannot loop forever.
 */
export function branchFocus(nodes: BranchNode[], selected: string | null): Set<string> | null {
  if (!selected) return null;
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!byId.has(selected)) return null;
  const visible = new Set<string>([selected]);
  const parents = (node: BranchNode) => node.parent_ids ?? (node.parent_id ? [node.parent_id] : []);
  const children = new Map<string, string[]>();
  nodes.forEach(child => {
    parents(child).forEach(parent => children.set(parent, [...(children.get(parent) || []), child.id]));
  });
  const descendants = new Set<string>([selected]);
  const queue = [selected];
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]) || []) {
      if (descendants.has(child)) continue;
      descendants.add(child); visible.add(child); queue.push(child);
    }
  }
  // Include all topic connections of the focused resources, and their ancestry,
  // without expanding those ancestors into unrelated sibling resources.
  const ancestors = Array.from(visible);
  for (let index = 0; index < ancestors.length; index++) {
    for (const parent of parents(byId.get(ancestors[index])!)) {
      if (!byId.has(parent) || visible.has(parent)) continue;
      visible.add(parent); ancestors.push(parent);
    }
  }
  return visible;
}
