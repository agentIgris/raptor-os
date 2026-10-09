/**
 * Tryout: the six-phase pipeline as a real state machine.
 *
 * Legacy declared nine transitions and implemented three. Both facts are
 * recorded in `./state-machine.ts` so a reader can tell recovered behaviour from
 * new, and neither is a silent surprise.
 */

export {
  LEGACY_IMPLEMENTED_TRANSITIONS,
  PHASES,
  TERMINAL_PHASES,
  TRANSITIONS,
  canTransition,
  isTerminal,
  skipsScreening,
  transition,
} from "./state-machine.js";

export type {
  TerminalPhase,
  TransitionContext,
  TransitionRequest,
  TryoutPhase,
} from "./state-machine.js";