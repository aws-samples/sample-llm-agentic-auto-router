---
status: accepted
---

# Admins manage providers in the console, inside a deploy-time egress boundary

Supersedes the part of ADR 0001 that fixed the provider registry at deploy time. Admins now add, edit and remove providers (endpoint, auth, dialects, models, prices, quirks) in the console, as a `providers` section of the configuration document, so a provider and the pools that use it activate, roll back and are audited together. An admin enters a provider's API key in the console; it is written to Secrets Manager under the deployment's provider prefix and never shown again, and the router reads only that prefix. Where prompts may go stays a deploy-time decision: the deployment declares an egress boundary (hostname patterns for the firewall mode, address ranges for the private mode) that the network enforces, and a provider outside it is refused when the configuration is validated. A deployment's `providersFile` remains the baked default, like its policy.

## Considered Options

- **Keep the registry deploy-time only (ADR 0001).** Rejected: adding a provider or rotating a key needed a redeploy by whoever owns the infrastructure.
- **Let admins change the egress boundary too (firewall rules, security groups).** Rejected: the console would hold network permissions, and a console admin could send every user's prompts anywhere. The boundary is the deployer's decision; the console only chooses inside it.
- **Admins pick from secrets the deployer created.** Rejected: a key rotation would still need the deployer.

## Consequences

- The console API role can create and update secrets under the provider prefix, and the router task role can read them; neither can touch other secrets.
- Network enforcement does not depend on the console's validation: a provider outside the boundary that slipped through would still be unreachable.
