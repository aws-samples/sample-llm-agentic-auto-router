// C1's CaptureClients over the SDK: Price List (us-east-1 endpoint, every page, TERM_MATCH regionCode) and Bedrock
// (ListInferenceProfiles SYSTEM_DEFINED, every page; ListFoundationModels) in the deploy Region. Same calls as
// packages/pricing/scripts/capture_prices.py.
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock'
import { paginateGetProducts, PricingClient } from '@aws-sdk/client-pricing'
import type { CaptureClients } from '@auto-router/pricing'

export function sdkCaptureClients(pricing: PricingClient, bedrock: BedrockClient): CaptureClients {
  return {
    async *getProducts({ serviceCode, regionCode }) {
      const pages = paginateGetProducts({ client: pricing }, {
        ServiceCode: serviceCode, FormatVersion: 'aws_v1', Filters: [{ Type: 'TERM_MATCH', Field: 'regionCode', Value: regionCode }],
      })
      // PriceList entries are LazyJsonString (String objects) at runtime: yield primitive strings.
      for await (const page of pages) for (const item of (page.PriceList ?? []) as unknown[]) yield String(item)
    },
    async listInferenceProfiles() {
      const out: Array<{ inferenceProfileId: string; status?: string }> = []
      let nextToken: string | undefined
      do {
        const page = await bedrock.send(new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED', maxResults: 1000, ...(nextToken ? { nextToken } : {}) }))
        for (const p of page.inferenceProfileSummaries ?? []) if (p.inferenceProfileId) out.push({ inferenceProfileId: p.inferenceProfileId, ...(p.status ? { status: p.status } : {}) })
        nextToken = page.nextToken
      } while (nextToken)
      return out
    },
    async listFoundationModels() {
      const page = await bedrock.send(new ListFoundationModelsCommand({}))
      return (page.modelSummaries ?? []).flatMap((m) => (m.modelId ? [{
        modelId: m.modelId,
        ...(m.modelName ? { modelName: m.modelName } : {}),
        ...(m.providerName ? { providerName: m.providerName } : {}),
        inferenceTypesSupported: [...(m.inferenceTypesSupported ?? [])],
        ...(m.modelLifecycle ? { modelLifecycle: { ...m.modelLifecycle } } : {}),
      }] : []))
    },
  }
}

/** Pricing API endpoint Region (the Price List API is served from us-east-1). */
export const PRICING_REGION = 'us-east-1'
export const pricingClient = (): PricingClient => new PricingClient({ region: PRICING_REGION })
export const bedrockClient = (region: string): BedrockClient => new BedrockClient({ region })
