import type { Action } from "#mcp/plan.ts";
import type { Scope } from "#scope.ts";
import { Ui } from "#ui.ts";

/** Carries out a plan, one harness change at a time. Removals come first in the plan. */
export async function applyActions(scope: Scope, actions: Action[]) {
  for (const action of actions) {
    // Two actions can edit the same harness file, so they must not run at the same time.
    // oxlint-disable-next-line no-await-in-loop
    await applyAction(scope, action);
  }
}

async function applyAction(scope: Scope, action: Action) {
  if (action.kind === "remove") {
    await action.adapter.mcp.remove(scope, action.name);
    Ui.info(`- ${action.name} (${action.adapter.id})`);

    return;
  }

  const target = await action.adapter.mcp.add(scope, action.server);
  Ui.info(`+ ${action.server.name} (${action.adapter.id}) -> ${target}`);
}
