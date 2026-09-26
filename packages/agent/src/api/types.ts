// Friendly aliases over the generated OpenAPI types. Regenerate schema.d.ts with `pnpm gen:api`.
import type { components } from "./schema.js";

type Schemas = components["schemas"];

export type ChatCreated = Schemas["ChatCreated"];
export type CreateChatRequest = Schemas["CreateChatRequest"];
export type CreateResponseRequest = Schemas["CreateResponseRequest"];
export type SubmittedPart = Schemas["SubmittedPart"];
export type ToolDefinition = Schemas["ToolDefinition"];
export type ResponseEvent = Schemas["ResponseEvent"];
export type HistoryPageResponse = Schemas["HistoryPageResponse"];
export type HistoryPart = Schemas["HistoryPart"];
export type RunInspection = Schemas["RunInspection"];
export type CatalogueModel = Schemas["CatalogueModel"];
export type ErrorEnvelope = Schemas["ErrorEnvelope"];
export type Usage = Schemas["Usage"];
export type ReasoningEffort = Schemas["ReasoningEffort"];
