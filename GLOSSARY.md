# LLM Auto Router

A router that sits between agent clients and model providers and picks, per request, which model serves a conversation, keeping identity, policy and cost accounting on one path.

## Language

**Provider**:
An upstream that serves inference: one set of endpoints, one way of authenticating, and the models reachable through them. Bedrock is the built-in provider; others are endpoints the deployer brings.
_Avoid_: Backend, upstream (as a noun for the whole thing), vendor

**Dialect**:
The client-facing API shape of a request: Anthropic Messages, OpenAI Chat Completions, or OpenAI Responses. A request keeps its dialect end to end; the router never translates between dialects.
_Avoid_: Protocol, format, API type

**Provider registry**:
The declaration of which providers other than Bedrock exist, how each is reached and authenticated, and which models with which prices each offers. Admins edit it as part of the configuration; a deployment may supply its initial value.
_Avoid_: Provider config, endpoint list

**Egress boundary**:
Where a deployment allows prompts to leave for providers other than Bedrock: hostname patterns or private address ranges, fixed at deploy time. Every provider in the registry must lie inside it.
_Avoid_: Allowlist (alone), egress config

**Family**:
A line of models from one provider whose conversation state may carry over between them. The same model line offered by two providers is two families.
_Avoid_: Vendor, model series

**Sibling**:
Another model of the same tier in the same pool, which a failing conversation moves to on its next call. A sibling may belong to a different provider.
_Avoid_: Fallback, backup model

**Pool**:
The set of models, each with a tier, that may serve requests of one dialect. Models from different providers may share a pool.
_Avoid_: Model list, group
