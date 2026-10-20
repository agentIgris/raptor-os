export {
  ASSISTANT_ROLES,
  ASSISTANT_TOOLS,
  TOOL_SCOPES,
  isToolAllowed,
  toolsForRole,
  type AssistantRole,
  type AssistantToolName,
} from "./matrix.js";

export {
  filterForRole,
  makeRegistry,
  makeTool,
  type AssistantSession,
  type AssistantTool,
  type AssistantToolRequest,
  type ToolRegistry,
  type ToolResult,
} from "./tools.js";

export {
  OFFLINE_DISCLAIMER,
  composeOfflineAnswer,
  type OfflineAnswer,
  type OfflineSection,
  type OfflineToolOutcome,
} from "./offline.js";

export {
  PROVIDER_TIMEOUT_MS,
  askProvider,
  readProviderConfig,
  type AskProviderInput,
  type ProviderConfig,
  type ProviderEnv,
} from "./provider.js";

export { buildSystemPrompt } from "./prompt.js";
