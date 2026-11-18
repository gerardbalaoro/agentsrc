export type SelectionAction =
  | { kind: "toggle"; id: string }
  | { kind: "all" | "completed"; ids: string[] }
  | { kind: "clear" | "scope" };

/** Selection belongs to one scope, independently of tabs, cursor position, and filtering. */
export function selectEntries(current: ReadonlySet<string>, action: SelectionAction) {
  if (action.kind === "clear" || action.kind === "scope") {
    return new Set<string>();
  }

  const selected = new Set(current);

  if (action.kind === "toggle") {
    if (selected.has(action.id)) {
      selected.delete(action.id);
    } else {
      selected.add(action.id);
    }
  } else if (action.kind === "all" || action.kind === "completed") {
    for (const id of action.ids) {
      if (action.kind === "all") {
        selected.add(id);
      } else {
        selected.delete(id);
      }
    }
  }

  return selected;
}
