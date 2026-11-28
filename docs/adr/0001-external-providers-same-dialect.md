---
status: accepted; registry location superseded by ADR 0002
---

# External providers: same-dialect passthrough, deploy-time registry, isolated by default

Providers other than Bedrock join the router only as compatible endpoints that serve a request in the dialect it arrived in: OpenAI Chat Completions, OpenAI Responses or Anthropic Messages, declared per model. The router still splices only the top-level `model` member and never translates between dialects, so a client is only ever served by a model that speaks its dialect natively. Which providers exist, how they are authenticated (Secrets Manager secrets the task role may read) and which models and prices they offer is fixed at deploy time in a provider registry. The console may place registered models in pools but cannot add providers. The router VPC stays isolated unless a deployment opts into egress: private endpoints over peering or PrivateLink, or public SaaS through NAT plus a Network Firewall domain allowlist derived from the registry, or the deployer's own egress.

## Considered Options

- **Translate between dialects, as LiteLLM does.** Rejected. Translation would let any client reach any model, but the router would then own a lossy protocol mapping (tools, reasoning, cache control, streaming events) and could no longer forward request bodies unchanged apart from `model`. A deployer who wants translation can put LiteLLM behind the router as one registered provider.
- **Providers editable in the console at runtime.** Rejected. Egress rules and secret grants are infrastructure, and a runtime-editable endpoint list would let a console admin send prompts anywhere.
- **NAT with only an application-level allowlist.** Rejected. Security groups cannot filter by domain, so a router bug or a compromised task would have unrestricted internet egress.

## Consequences

- Conversation state that cannot be moved between models (encrypted reasoning, response chains) never crosses a provider boundary, and a family is scoped to one provider.
- Bedrock-specific behaviour (compatibility patches such as its `anthropic-beta` deny list, inference profile rotation, `service_tier` injection, IAM grant sync, catalog refresh) applies to Bedrock only. External models get core's same-tier sibling failover, which may cross providers; provider differences are absorbed by the provider itself or by declarative per-provider quirks in the registry, never by vendor-specific router code.
