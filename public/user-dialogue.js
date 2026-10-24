import { expandedSections } from './user-job-view.js';
import * as dialogue from './full-dialogue-ui.js';
import { friendly } from './user-flow.js';
export const initializeFullDialogue = dialogue.initializeFullDialogue;
export const completeScript = dialogue.completeScript;
const displayPlan = plan => plan ? { ...plan, blockers: plan.blockers?.map(friendly) } : plan;
export function allocationPreview(plan, error, demo, dirty) {
  return dialogue.allocationPreview(displayPlan(plan), friendly(error), demo, dirty);
}
export function fullDialogueEditor(project, edits, options = {}) {
  return expandedSections(dialogue.fullDialogueEditor(project, edits, { ...options, plan: displayPlan(options.plan), error: friendly(options.error) }));
}
