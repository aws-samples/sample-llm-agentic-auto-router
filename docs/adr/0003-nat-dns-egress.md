---
status: accepted
---

# A cheaper public egress mode filters provider hosts by DNS, following the active configuration

Adds `-c providerEgressMode=nat-dns` beside `firewall` (ADR 0001, 0002). The router subnets route to a NAT gateway (one in the first AZ, or one per AZ, `providerEgressAzs`), the router security group opens TLS on 443 to the internet, and a Route 53 Resolver DNS Firewall rule group on the router VPC resolves only AWS service names (`*.amazonaws.com`, first, so every VPC endpoint and AWS call keeps working) and a provider list. Every other name gets NXDOMAIN. `-c providerHosts` is the ceiling of what may ever be reached. It may be `*`, any host: the deployer then delegates the choice of destinations to console admins. The provider list is not the ceiling. It is the exact hosts of the providers in the configuration the router runs (the active document's providers section, else the baked one). CloudFormation does not manage its content. A sync function replaces it at every console activation, before `config/active.json` is written, and at deploy. If the sync fails, the activation fails, so the configuration and the allow list always agree. The boundary the router and the console check is the same as for `firewall`: hosts inside the ceiling, port 443 only.

The deciding factors are cost and operations. A Network Firewall endpoint costs about USD 290/month per AZ before traffic. The NAT gateway and DNS Firewall cost tens of dollars at this deployment's scale. And adding a provider must not need a redeploy. The price is a weaker guarantee, stated plainly in `infra/README.md`. DNS filtering controls which names resolve, not where packets go. A client that connects to an IP address directly, or resolves names through DNS over HTTPS, reaches any address on 443. So `nat-dns` stops ordinary misrouting and casual exfiltration by name, not a compromised task.

## Considered Options

- **Network Firewall only (`firewall`).** Kept as the mode for destination enforcement by TLS SNI. Rejected as the only public mode: about USD 290/month per AZ is too much for a small deployment that only needs a few SaaS providers.
- **A DNS allow list fixed at deploy time (CloudFormation domains).** Rejected: every provider an admin adds would need a redeploy by whoever owns the infrastructure. That operations burden was the user's objection, and ADR 0002 already moved provider changes into the console.
- **No DNS filtering (`bring-your-own`, the application-level boundary check only).** Rejected: ADR 0001 keeps the network as the enforcement point. A deployment that adds a NAT gateway and nothing else would let a misconfigured router send prompts to any host.
- **Map `nat-dns` onto boundary mode `firewall`.** Rejected: the console would show a firewall that does not exist. The boundary gets its own mode, checked like `firewall`.

## Consequences

- An activation now depends on the sync function and the Route 53 Resolver API. Their outage blocks configuration changes, never routing.
- `nat-dns` and `firewall` share the NAT layer under the same construct ids, so switching between them keeps the NAT gateways and their public addresses.
- The DNS Firewall applies to the whole router VPC. Anything placed in it later resolves only AWS names and the configured providers' hosts.
- The VPC must stay fail-closed (`FirewallFailOpen` `DISABLED`, the service default). CloudFormation cannot set it; `infra/README.md` gives the check to run after a deploy.
