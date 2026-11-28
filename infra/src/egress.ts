// Public egress to external providers (design docs/tasks/11-28-external-providers §5, ADRs 0001 and 0003). Two modes
// share one NAT layer (natLayer: internet gateway, NAT subnets, Elastic IPs, NAT gateways) with the same construct ids,
// so switching firewall <-> nat-dns keeps the NAT gateways and their public addresses:
// - firewall (EgressFirewall): the router reaches the registry's public https hostnames (TLS SNI), and nothing else on
//   the internet.
// - nat-dns (EgressNatDns): router subnets route straight to the NAT gateway; a Route 53 Resolver DNS Firewall on the VPC
//   resolves only AWS service names and the registry's hostnames. Cheaper, and bypassable by a client that skips DNS.
//
// Subnet layout in the VPC's 10.90.0.0/24 (the router's two isolated /26 subnets are 10.90.0.0/26 and 10.90.0.64/26):
//   10.90.0.128/28, 10.90.0.144/28  NAT subnets, AZ 0 and AZ 1 (both modes; AZ 1 only with providerEgressAzs=2)
//   10.90.0.192/28, 10.90.0.208/28  firewall subnets, AZ 0 and AZ 1 (firewall mode only)
//   10.90.0.160/27, 10.90.0.224/27  free
//
// firewall mode:
// Architecture (Network Firewall developer guide, "firewall before the NAT gateway"; knowledge-center article
// network-firewall-set-up-with-nat-gateway): router subnet → firewall endpoint → NAT gateway → internet gateway.
//   router subnet RT   0.0.0.0/0 → the firewall endpoint of its AZ (AZ 0 with providerEgressAzs=1)
//   firewall subnet RT 0.0.0.0/0 → the NAT gateway of the AZ
//   NAT subnet RT      0.0.0.0/0 → internet gateway; <router subnet CIDR> → that subnet's firewall endpoint (return path)
// The firewall sees the tasks' own addresses (alert logs show them), and the internet gateway needs no edge route table.
// The subnets are added beside the VPC construct's isolated subnets (10.90.0.128/25), so switching modes never
// replaces the router subnets or the VPC endpoints.
//
// One firewall per AZ, sharing one policy: a firewall's EndpointIds attribute is unordered ("az:vpce-id"), and with a
// single subnet per firewall its one endpoint is selectable with intrinsic functions alone (billing is per endpoint-hour
// either way).
//
// Rules (STRICT_ORDER; default actions aws:drop_established + aws:alert_established): drop_established drops only
// packets of established connections, so the TCP handshake to 443 completes and the TLS ClientHello's SNI is then
// matched by the pass rules; an established flow that matches none (another SNI, no SNI, not TLS) is dropped and
// logged. TCP to other ports, UDP and ICMP are dropped outright. Verified against the documentation only (not deployed).
import { Fn, RemovalPolicy, aws_ec2 as ec2, aws_logs as logs, aws_networkfirewall as nfw, aws_route53resolver as r53r } from 'aws-cdk-lib'
import { Construct } from 'constructs'

/** Fixed, so a registry change never replaces the rule group (capacity is immutable): 1 rule per host plus the drops. */
export const EGRESS_RULE_CAPACITY = 250
/** Allowlist rule ids start here (the drop rules use the 1009xx range). */
const SID_BASE = 1_000_001

export interface EgressFirewallProps {
  prefix: string
  vpc: ec2.IVpc
  /** The router subnets (the VPC construct's isolated subnets), one per AZ, in azIds order. */
  routerSubnets: readonly ec2.ISubnet[]
  /** AZ IDs of the router subnets (the same order). */
  azIds: readonly string[]
  /** 1: NAT gateway and firewall endpoint in AZ 0 only (both router subnets use them); 2: one per AZ. */
  azs: 1 | 2
  /** Hostnames to pass (TLS SNI, exact match). */
  hosts: readonly string[]
}

/** The Suricata rules of the allowlist: exact SNI matches on 443, then explicit drops. Pure, for tests and README. */
export function egressRules(hosts: readonly string[]): string {
  const pass = hosts.map((h, i) => {
    if (!/^(\*\.)?[a-z0-9.-]+$/.test(h)) throw new Error(`egress host '${h}' is not a lowercase DNS name or *.<domain> pattern`)
    // `*.example.com`: any name ending in `.example.com` (one or more labels), never the apex or `evilexample.com`.
    const match = h.startsWith('*.') ? `content:"${h.slice(1)}"; nocase; endswith;` : `content:"${h}"; nocase; startswith; endswith;`
    return `pass tls $HOME_NET any -> $EXTERNAL_NET 443 (tls.sni; ${match} msg:"provider ${h}"; flow:to_server, established; sid:${SID_BASE + i}; rev:1;)`
  })
  return [
    ...pass,
    'drop tcp $HOME_NET any -> $EXTERNAL_NET !443 (msg:"provider egress: TCP to a port other than 443"; flow:to_server; sid:1000901; rev:1;)',
    'drop udp $HOME_NET any -> $EXTERNAL_NET any (msg:"provider egress: UDP"; sid:1000902; rev:1;)',
    'drop icmp $HOME_NET any -> $EXTERNAL_NET any (msg:"provider egress: ICMP"; sid:1000903; rev:1;)',
  ].join('\n')
}

/** Subnet CIDRs beside the router's two /26 subnets in 10.90.0.0/24: NAT subnets .128/.144, firewall subnets .192/.208. */
export const NAT_CIDRS = ['10.90.0.128/28', '10.90.0.144/28'] as const
export const FIREWALL_CIDRS = ['10.90.0.192/28', '10.90.0.208/28'] as const

type Tag = (name: string) => { key: string; value: string }[]

/** A subnet with its own route table (construct ids `<sid>`, `<sid>Rt`, `<sid>RtAssoc`). */
function subnetWithRt(scope: Construct, vpc: ec2.IVpc, tag: Tag, sid: string, cidr: string, az: string, name: string) {
  const subnet = new ec2.CfnSubnet(scope, sid, { vpcId: vpc.vpcId, cidrBlock: cidr, availabilityZoneId: az, mapPublicIpOnLaunch: false, tags: tag(name) })
  const rt = new ec2.CfnRouteTable(scope, `${sid}Rt`, { vpcId: vpc.vpcId, tags: tag(name) })
  new ec2.CfnSubnetRouteTableAssociation(scope, `${sid}RtAssoc`, { subnetId: subnet.ref, routeTableId: rt.ref })
  return { subnet, rt }
}

/**
 * The NAT layer both modes share: an internet gateway and, per AZ (`azs`), a NAT subnet whose route table sends
 * 0.0.0.0/0 to the IGW, an Elastic IP and a public NAT gateway. Construct ids are fixed (Igw, IgwAttachment,
 * NatSubnet<i>[Rt|RtAssoc], NatEip<i>, Nat<i>, NatDefault<i>), so under the same parent the logical ids are the same in
 * both modes. The subnets map no public IPs on launch: only the NAT gateway has one (its Elastic IP).
 */
function natLayer(scope: Construct, props: { vpc: ec2.IVpc; azIds: readonly string[]; azs: 1 | 2 }, tag: Tag) {
  const { vpc } = props
  const igw = new ec2.CfnInternetGateway(scope, 'Igw', { tags: tag('egress-igw') })
  const attach = new ec2.CfnVPCGatewayAttachment(scope, 'IgwAttachment', { vpcId: vpc.vpcId, internetGatewayId: igw.ref })
  const nats: ec2.CfnNatGateway[] = []
  const natRts: ec2.CfnRouteTable[] = []
  for (let i = 0; i < props.azs; i++) {
    const nat = subnetWithRt(scope, vpc, tag, `NatSubnet${i}`, NAT_CIDRS[i] as string, props.azIds[i] as string, `egress-nat-${i}`)
    const eip = new ec2.CfnEIP(scope, `NatEip${i}`, { domain: 'vpc', tags: tag(`egress-nat-${i}`) })
    eip.addDependency(attach)
    nats.push(new ec2.CfnNatGateway(scope, `Nat${i}`, { subnetId: nat.subnet.ref, allocationId: eip.attrAllocationId, connectivityType: 'public', tags: tag(`egress-nat-${i}`) }))
    const toIgw = new ec2.CfnRoute(scope, `NatDefault${i}`, { routeTableId: nat.rt.ref, destinationCidrBlock: '0.0.0.0/0', gatewayId: igw.ref })
    toIgw.addDependency(attach)
    natRts.push(nat.rt)
  }
  return { igw, attach, nats, natRts }
}

export class EgressFirewall extends Construct {
  readonly logGroup: logs.LogGroup
  readonly firewalls: nfw.CfnFirewall[] = []

  constructor(scope: Construct, id: string, props: EgressFirewallProps) {
    super(scope, id)
    const { vpc, prefix } = props
    const n = (x: string) => `${prefix}-${x}`
    const tag = (name: string) => [{ key: 'Name', value: n(name) }]
    const { nats, natRts } = natLayer(this, props, tag)

    const ruleGroup = new nfw.CfnRuleGroup(this, 'AllowList', {
      ruleGroupName: n('egress-allow'), type: 'STATEFUL', capacity: EGRESS_RULE_CAPACITY,
      description: 'External provider egress: TLS on 443 to the registry hostnames only',
      ruleGroup: { rulesSource: { rulesString: egressRules(props.hosts) }, statefulRuleOptions: { ruleOrder: 'STRICT_ORDER' } },
    })
    const policy = new nfw.CfnFirewallPolicy(this, 'Policy', {
      firewallPolicyName: n('egress'),
      firewallPolicy: {
        statelessDefaultActions: ['aws:forward_to_sfe'], statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
        statefulEngineOptions: { ruleOrder: 'STRICT_ORDER' },
        statefulDefaultActions: ['aws:drop_established', 'aws:alert_established'],
        statefulRuleGroupReferences: [{ resourceArn: ruleGroup.attrRuleGroupArn, priority: 100 }],
      },
    })
    this.logGroup = new logs.LogGroup(this, 'Alerts', { logGroupName: `/${prefix}/egress-firewall`, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY })

    const endpoints: string[] = []
    for (let i = 0; i < props.azs; i++) {
      const az = props.azIds[i] as string
      const fw = subnetWithRt(this, vpc, tag, `FirewallSubnet${i}`, FIREWALL_CIDRS[i] as string, az, `egress-firewall-${i}`)
      const natGw = nats[i] as ec2.CfnNatGateway
      const firewall = new nfw.CfnFirewall(this, `Firewall${i}`, {
        firewallName: n(`egress-${i}`), firewallPolicyArn: policy.attrFirewallPolicyArn, vpcId: vpc.vpcId,
        subnetMappings: [{ subnetId: fw.subnet.ref }], deleteProtection: false, subnetChangeProtection: false, firewallPolicyChangeProtection: false,
        description: `External provider egress, AZ ${az}`,
      })
      new nfw.CfnLoggingConfiguration(this, `Logging${i}`, {
        firewallArn: firewall.attrFirewallArn,
        loggingConfiguration: { logDestinationConfigs: [{ logType: 'ALERT', logDestinationType: 'CloudWatchLogs', logDestination: { logGroup: this.logGroup.logGroupName } }] },
      })
      this.firewalls.push(firewall)
      // The single endpoint of this firewall: "az:vpce-id" → vpce-id.
      endpoints.push(Fn.select(1, Fn.split(':', Fn.select(0, firewall.attrEndpointIds))))
      new ec2.CfnRoute(this, `FirewallDefault${i}`, { routeTableId: fw.rt.ref, destinationCidrBlock: '0.0.0.0/0', natGatewayId: natGw.ref })
    }
    props.routerSubnets.forEach((s, j) => {
      const i = props.azs === 2 ? j : 0
      new ec2.CfnRoute(this, `RouterDefault${j}`, { routeTableId: s.routeTable.routeTableId, destinationCidrBlock: '0.0.0.0/0', vpcEndpointId: endpoints[i] as string })
      // Return path: the NAT gateway's subnet sends the router subnet's replies back through the same firewall endpoint.
      new ec2.CfnRoute(this, `RouterReturn${j}`, { routeTableId: (natRts[i] as ec2.CfnRouteTable).ref, destinationCidrBlock: s.ipv4CidrBlock, vpcEndpointId: endpoints[i] as string })
    })
  }
}

// ---------------------------------------------------------------- nat-dns (ADR 0003)
//   router subnet RT  0.0.0.0/0 -> the NAT gateway of its AZ (AZ 0 with providerEgressAzs=1)
//   NAT subnet RT     0.0.0.0/0 -> internet gateway
// Hostname filtering is by Route 53 Resolver DNS Firewall, one rule group associated with the VPC (rules evaluated from
// the lowest priority number up; the first match decides):
//   100  ALLOW  <prefix>-egress-aws        *.amazonaws.com    every AWS service name the VPC resolves (endpoints' private
//                                                             DNS, S3/DynamoDB gateway names, ECR layer buckets, ...)
//   200  ALLOW  <prefix>-egress-providers  (runtime)          the exact hosts of the effective configuration's providers
//   300  BLOCK  <prefix>-egress-all        *                  NXDOMAIN for everything else
// The provider list has no Domains in the template: CloudFormation never manages its content, so a deploy never wipes
// it. The provider-dns-sync function (packages/catalog-service provider-dns.ts) replaces it from the configuration on
// every console activation (before config/active.json is written) and from a deploy-time Trigger.
// The allow rules trust the redirection chain (TRUST_REDIRECTION_DOMAIN): a provider name that is a CNAME to a CDN name
// resolves, instead of the CDN name meeting the block rule. The VPC's firewall config keeps its default fail-closed
// mode (FirewallFailOpen DISABLED; CloudFormation has no resource for it, see infra/README.md). Not query-logged.

/** The AWS service names every mode must keep resolvable (DNS Firewall domain syntax): first rule, highest priority. */
export const AWS_SERVICE_DOMAINS: readonly string[] = ['*.amazonaws.com']
/** The association's priority among DNS Firewall rule groups on the VPC (valid 101-9899; others may go before or after). */
export const DNS_FIREWALL_ASSOCIATION_PRIORITY = 1000

export interface DnsFirewallRule {
  /** Construct id and domain list name suffix (`<prefix>-egress-<list>`). */
  list: 'aws' | 'providers' | 'all'
  /** The list's domains in the template; 'runtime' = none (provider-dns-sync owns the content). */
  domains: string[] | 'runtime'
  action: 'ALLOW' | 'BLOCK'
  priority: number
}

/** The DNS Firewall rules of nat-dns, in priority order. Pure, for tests and README. */
export function dnsFirewallRules(): DnsFirewallRule[] {
  return [
    { list: 'aws', domains: [...AWS_SERVICE_DOMAINS], action: 'ALLOW', priority: 100 },
    { list: 'providers', domains: 'runtime', action: 'ALLOW', priority: 200 },
    { list: 'all', domains: ['*'], action: 'BLOCK', priority: 300 },
  ]
}

export interface EgressNatDnsProps {
  prefix: string
  vpc: ec2.IVpc
  /** The router subnets (the VPC construct's isolated subnets), one per AZ, in azIds order. */
  routerSubnets: readonly ec2.ISubnet[]
  /** AZ IDs of the router subnets (the same order). */
  azIds: readonly string[]
  /** 1: one NAT gateway in AZ 0 (both router subnets use it); 2: one per AZ. */
  azs: 1 | 2
}

export class EgressNatDns extends Construct {
  readonly ruleGroup: r53r.CfnFirewallRuleGroup
  readonly association: r53r.CfnFirewallRuleGroupAssociation
  /** The provider allow list (no Domains in the template): provider-dns-sync replaces its content. */
  readonly providerList: r53r.CfnFirewallDomainList

  constructor(scope: Construct, id: string, props: EgressNatDnsProps) {
    super(scope, id)
    const { vpc, prefix } = props
    const n = (x: string) => `${prefix}-${x}`
    const tag = (name: string) => [{ key: 'Name', value: n(name) }]
    const rules = dnsFirewallRules()

    const lists = rules.map((r) => new r53r.CfnFirewallDomainList(this, `DomainList-${r.list}`, {
      name: n(`egress-${r.list}`), ...(r.domains === 'runtime' ? {} : { domains: r.domains }) }))
    this.providerList = lists[rules.findIndex((r) => r.list === 'providers')] as r53r.CfnFirewallDomainList
    this.ruleGroup = new r53r.CfnFirewallRuleGroup(this, 'DnsFirewall', {
      name: n('egress-dns'),
      firewallRules: rules.map((r, i) => ({
        firewallDomainListId: (lists[i] as r53r.CfnFirewallDomainList).attrId, priority: r.priority, action: r.action,
        ...(r.action === 'BLOCK' ? { blockResponse: 'NXDOMAIN' } : { firewallDomainRedirectionAction: 'TRUST_REDIRECTION_DOMAIN' }),
      })),
    })
    this.association = new r53r.CfnFirewallRuleGroupAssociation(this, 'DnsFirewallAssociation', {
      name: n('egress-dns'), firewallRuleGroupId: this.ruleGroup.attrId, vpcId: vpc.vpcId,
      priority: DNS_FIREWALL_ASSOCIATION_PRIORITY, mutationProtection: 'DISABLED',
    })

    const { nats } = natLayer(this, props, tag)
    props.routerSubnets.forEach((s, j) => {
      const nat = nats[props.azs === 2 ? j : 0] as ec2.CfnNatGateway
      const route = new ec2.CfnRoute(this, `RouterDefault${j}`, { routeTableId: s.routeTable.routeTableId, destinationCidrBlock: '0.0.0.0/0', natGatewayId: nat.ref })
      // No internet route before the DNS filter is in place.
      route.addDependency(this.association)
    })
  }
}
