export interface AgentNamespaces {
  main: string;
  subagent: string;
}

/** Every harness namespace lives under this prefix, so runs never touch the org-global scope. */
export const NAMESPACE_PREFIX = "twigg-agent";

/**
 * The main agent's chats go in `twigg-agent/<ns>`, whose system prompt is set on the Twigg dashboard.
 * Subagents go one level below, so they inherit it but can be given their own. The harness never
 * writes namespace configuration.
 */
export function agentNamespaces(userNamespace: string): AgentNamespaces {
  // Accept a namespace given with or without the prefix, without doubling it.
  const rel = userNamespace.replace(new RegExp(`^${NAMESPACE_PREFIX}(/|$)`), "");
  const main = rel ? `${NAMESPACE_PREFIX}/${rel}` : NAMESPACE_PREFIX;
  return { main, subagent: `${main}/subagent` };
}
