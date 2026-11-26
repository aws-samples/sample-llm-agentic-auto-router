# @auto-router/pricing

This package has no runtime dependencies. It provides:

- versioned Bedrock price catalogs per Region (bundled: ap-northeast-1, ap-southeast-1, us-west-2), plus a pipeline to add a Region;
- usage normalizers for Anthropic Messages, OpenAI Chat Completions and OpenAI Responses, both streaming and non-streaming;
- a cost calculator with long-context tiers.

The contract is documented in `docs/tasks/11-04-llm-auto-router/design.md` §3. The design detail is in `docs/tasks/11-04-pricing-usage/design.md`.

```ts
import { loadCatalog, findModel, normalizeUsage, createStreamUsageAccumulator, parseSse, costOf } from '@auto-router/pricing'

const catalog = loadCatalog('ap-southeast-1')   // throws CatalogError for a Region without a bundled catalog
const usage = normalizeUsage('anthropic-messages', responseBody)
const cost = costOf(usage, findModel(catalog, 'global.anthropic.claude-haiku-5-5')!)
```

## Behaviour to know

- **Chat Completions streams carry usage only when the request sets `stream_options.include_usage`.** Without it, Bedrock sends no usage and `result()` returns `undefined`.
- OpenAI-shape cache writes are attributed to the `30m` TTL, because Bedrock returns no TTL breakdown.
- Long-context pricing applies to the whole request when `promptTokens > longContext.aboveTokens`: 100,000 for Haiku 5.5 and 272,000 for GPT.

## Service tiers

Bedrock's OpenAI-compatible APIs take a `service_tier` body member: `default` (Standard), `flex` (a discount) or `priority` (a premium), for the models that offer them (task `11-17-bedrock-service-tier`).

- `ModelPrice.serviceTier` (absent = `default`) is the tier the router asks for when the client sends none. Kimi and GLM default to `flex`: in some accounts their Standard quota is 0. Shipped: `global.moonshotai.kimi-k3` is `flex`.
- `ModelPrice.tierPrices` holds the `flex` / `priority` prices, with a `longContext` price when the model has one. `validateCatalog` requires the same cache TTLs as the base price.
- `costOf(usage, price, tier)` prices at the tier the response reported. `default` and `standard` are the base price. A tier without a price is priced at the base price, and the breakdown carries `tierUnpriced`.
- `requestedServiceTier(price, dialect)` is the tier a request asks for when the client sends none: the model's `serviceTier` on Chat Completions and Responses, `default` on Messages. Estimates use it for models no response has priced yet: core's cost gate, the savings baselines and projections, replay, and the assessor and rules-translator calls.
- Capture keeps the flex and priority rows (`…-global-flex`, `…_global_flex`, in-Region `…-flex`) and drops batch, provisioned, reserved and committed rows. A row whose `service_tier` attribute names a tier must also name it in its usagetype. Such snapshots carry `tierRows: true`.
- The builder fills `tierPrices` from tier rows, but only from snapshots with `tierRows`. The ap-southeast-1 and us-west-2 price snapshots were recaptured with tier rows on 2026-11-17, so their catalogs carry Kimi K3's flex and priority prices from its `…-global-flex` / `…-global-priority` rows (us-west-2 also the in-Region Kimi K2.5's). The frozen Tokyo snapshot has no tier rows. With no row for the model's own tier, the builder uses `TIER_MULTIPLIERS` (flex ×0.5, priority ×1.75) and names it in `priceSource`, for example `price-list:us-west-2; flex ×0.5 (no Price List row)`.
- `modelCardPrice.tierPrices` sets tier prices for models priced by their model card. Without it, the same multiplier applies to the model's own tier.
- In ModelsFile v2, `serviceTier` is a tracked field (`META_FIELDS`), and `editModel` sets it (`null` removes it). Templates copy it from the predecessor or the family defaults. The `glm` family is provider `zai`, line `glm`, on Chat and Responses, with no prompt caching.

## Catalogs per Region

- `loadCatalog(region)` returns the bundled catalog for `region`, and `catalogRegions()` lists the bundled Regions. With no argument it returns the reference catalog (`ap-northeast-1`), which offline tools such as replay, evals and tests use. Deployments always pass their Region.
- `data/models.json` holds the Region-independent model metadata: family, tier, dialects, context window, cache behaviour and the Price List SKU naming. Prices come from each Region's snapshots.
- `data/catalog.ap-northeast-1.json` (2026-11-04.1) is frozen so replays stay reproducible. A test proves the builder reproduces every one of its prices from the Tokyo snapshots.
- `data/catalog.ap-southeast-1.json` (2026-11-17.1) is built from its snapshots, and a test rebuilds it and compares. Every global-profile price it shares with Tokyo is equal. Singapore has its own Sonnet 5.5 SKU, and Kimi K2.5 has no SKU there.
  - Claude Fable 5.2 (`global.anthropic.claude-fable-5-2`, frontier) was added on 2026-11-10. The 2026-11-10 recapture changed no other price. Tokyo stays frozen without it.
- `data/catalog.us-west-2.json` (2026-11-17.20) is built from its snapshots, and a test rebuilds it and compares. Its label was given to `build-catalog.ts --version` so it sits above the versions the live us-west-2 bucket had already published; the refresh's first publish after it is `2026-11-17.21`. It has every Singapore model at the same price, plus the in-Region `moonshotai.kimi-k2.5` from its own us-west-2 SKU.

## Adding or refreshing a Region

All AWS calls are read-only: `pricing:GetProducts`, `bedrock:ListInferenceProfiles` and `bedrock:ListFoundationModels`.

```
uv run packages/pricing/scripts/capture_prices.py --region <aws-region> [--fallback-region us-east-1] [--expect-account <id>]
node packages/pricing/scripts/build-catalog.ts --region <aws-region> [--version YYYY-MM-DD.N]
node packages/pricing/scripts/gen-catalog.ts
pnpm -C packages/pricing typecheck && pnpm -C packages/pricing test
```

- `capture_prices.py` writes `data/snapshots/price-list.<region>.json` and `bedrock-ids.<region>.json`. It keeps on-demand rows of the Standard, Flex and Priority tiers (see Service tiers).
  - A model with no SKU in the Region uses the `--fallback-region` global-profile SKU, recorded as such in `priceSource`.
  - Global profiles without any Price List SKU use `modelCardPrice` from `models.json`.
- `build-catalog.ts` includes only models the Region offers: an inference profile, or an on-demand foundation model for in-Region ids. Everything else is listed under `excluded` with a reason.
- To use a catalog without bundling it, pass the JSON file to the router (`ROUTER_CATALOG_FILE`) and to the infra app (`-c catalogFile=`). Both validate it and require its `region` to match.
- New models need an entry in `data/models.json`: metadata, plus `sku` (Price List `model` name and scheme) or `modelCardPrice`.

Known gaps as of 2026-11-04:

- Tokyo has no Sonnet 5.5 SKU, so it uses the us-east-1 global SKU.
- GPT models other than GPT-6 Astra have no Price List SKU, so their prices come from the model cards.
- GPT-5.5 and 5.4 are excluded because no global price is published.

`gen-catalog.ts` also writes `src/meta.data.ts` from `data/models.json` and `data/family-defaults.json`. The runtime images copy `src/` only, so this is how the Lambdas and the router read that data. A test fails if the module is out of date.

## Dynamic catalog building blocks

These are pure functions for the refresh and grant Lambdas and the runtime loaders (design: `docs/tasks/11-16-dynamic-catalog/design.md` §1–§3). They make no AWS SDK calls and do no I/O, and `node:` modules are used in tests only. The callers do the S3, Price List, Bedrock and IAM calls.

**Stored metadata (`catalog/models.json`, ModelsFile v2)**

- `seedModelsFile(shippedModelsFile(), now)` turns the shipped v1 file into v2. Every model becomes `confirmed`, and each field it has is sourced `shipped`. `readModelsFile(value)` accepts v1 (and seeds it) or v2 (and validates it). `validateModelsFile` lists every problem it finds.
- Each model has a `state`: `confirmed` (built into catalogs), `pending`, `unclassified` or `retired` (no longer offered). It can also have a `stateReason`: `needs-price`, `unknown-family`, `not-offered`, `reoffered` or `unconfirmed`. LEGACY is not a state: it is recorded in `lifecycle`.
- `grant` is optional and is written only by the grant Lambda, with If-Match conditional writes.
- `fieldSources` gives the source of each `META_FIELDS` entry: `shipped`, `api`, `admin` or `template:<model id | family | unclassified | tier-rules | default-tier>`.
- `setModelState(..., 'confirmed', now, 'admin')` records `confirmedBy: 'admin'` (absent for seeded/shipped confirmations, cleared on un-confirm). The grant Lambda grants a shipped model beyond the CloudFormation base only when an admin confirmed it.
- `editModel(file, id, edit)` marks each edited field `admin`. Setting the family of an `unclassified` model moves it to `pending`. It refuses an edit after which a confirmed model would fail `checkConfirmable` (for example a new cache TTL without a model-card cache-write price).
- `setModelState(file, id, 'confirmed' | 'pending')` refuses to confirm while `checkConfirmable` reports problems. It reports a model with no price source (no SKU and no model-card or admin price), an unclassified one, a retired one, or invalid metadata. For a model priced only by a model card (or an admin price), it builds the catalog entry and runs the catalog validator's entry rules on it, so any price the catalog would refuse is `needs-price` with the fields concerned: a missing long-context price when `longContextAboveTokens` is set, or a cache TTL without its cache-write price. SKU prices come from the Region's Price List at build time. It does not change a retired or unclassified model.

**Templates (`data/family-defaults.json`)**

- `lineOf(id)` splits an id into scope, provider, line and version. For example, `global.openai.gpt-6.1-sol` is scope `global`, provider `openai`, line `gpt-sol` and version `[6, 1]`.
- `templateFor(id, file, now)` takes a new model's metadata from its predecessor: the newest confirmed model with the same provider, line and endpoint scope that is not newer. Without a predecessor it uses the family defaults; tier then comes from the naming rules, else `defaultTier`. A model of an unknown family is `unclassified`.
- Templates never supply availability, lifecycle, the SKU, billed cache TTLs, long-context presence or prices.
- `discovery` sets which Region ids are added automatically (`discoveryCandidates`). By default: global profiles, and in-Region on-demand models of providers that a family rule lists. To widen it per deployment, add `geo` to `scopes`; geographic profiles are then added only when there is no global profile of the same base model, while `geoOnlyWithoutGlobal` is true.

**Capture**

- `captureSnapshot(clients, { region, fallbackRegion?, skuNames })` is the TypeScript port of `capture_prices.py`. You inject a `CaptureClients` (`getProducts`, `listInferenceProfiles`, `listFoundationModels`).
- It produces the same rows, ids and fallback rule as the Python script. It also records each foundation model's `modelName` and `lifecycle`, and keeps the rows of SKU names derived from `modelName`, so a newly launched model is priced in the same snapshot.
- It returns one merged `CatalogSnapshot`. `mergeSnapshots` / `splitSnapshot` convert between it and the committed two-file form.

**Discover and build**

- `discover(file, snapshot, now, { previous?, retireAfterMisses = 3, incompleteRatio = 0.2 })` returns `{ file, changes, listingIncomplete? }`:
  - Region ids that are new (not curated-excluded, not LEGACY) are added from templates, and their API fields are applied: the SKU named from `modelName`, the billed TTLs and long-context presence from the usagetype rows, and `needs-price`.
  - Pending models have their API fields re-derived on every run.
  - A confirmed model the Region does not offer counts a miss (`missedRefreshes`, change `missed`). It becomes `retired` at the third miss in a row, and the counter resets when the model is offered again. Other models retire at the first miss. A retired model offered again goes back to `pending` (`reoffered`), or to `unclassified` if its family was never set.
  - A LEGACY model keeps its state and stays in the catalog, since it still serves requests; only `lifecycle` changes.
  - If more than 20 % of the confirmed models offered in `previous` are missing, the listing is treated as incomplete. Nothing about availability changes (no misses, retirements, reoffers or new models), and the result carries `listingIncomplete`. With `acceptIncomplete: true` (the admin "refresh and accept removals" action) the changes are applied as usual and the result carries `listingIncompleteAccepted`; `structuralGuards` then gives a `listing-incomplete-accepted` warning instead of the blocking notice.
- `addModel(file, snapshot, id, now)` is the admin "add from the refreshed list". It adds one id the snapshot offers, in any scope or from any provider, through the same template path, as `pending` or `unclassified`. It throws if the snapshot does not offer the id, or the file already lists or excludes it.
  - Confirmed metadata is never changed.
- `buildFromStore(file, snapshot, { version? })` builds a validated catalog from the `confirmed` models only. Retired models are listed under `excluded`, and so are confirmed models it leaves out: not offered, no price rows, or an entry the catalog validator refuses (reason `invalid catalog entry: <problems>`). One bad confirmed entry never fails the build; the build fails only when no model is left.
- Seeding the shipped models and building from the committed ap-southeast-1 or us-west-2 snapshot reproduces the bundled catalog exactly.

**Publish decisions**

- `contentHash(catalog)` is a SHA-256 of the canonical JSON. It ignores `version`, `asOf` and `source`.
- `nextVersion(prev, 'YYYY-MM-DD')` returns the next version and never goes backwards. Give it the newest published version, not the current one: after a rollback, `.N+1` of the current version can already exist. `nextPointerVersion(pointer, date)` does this from the pointer's history.
- `diffCatalogs(prev, next, { alertThresholdPercent = 20 })` lists `old → new` with the percentage for each price field, plus added, removed and metadata changes. Its `alert` is set when any field moves by more than the threshold, or a price field appears or disappears.
- `structuralGuards({ prev, next, policyModels, file, listingIncomplete? })` returns `publish: false` with a `block` notice when a policy model is missing from `next` or the listing is incomplete.
  - A LEGACY policy model is a `warning` and does not block.
  - Other LEGACY models, models leaving the catalog, and pending or unclassified models produce `info` notices.
  - A confirmed model the Region offers but the build left out (no price rows, or an invalid entry), and that is neither a policy model nor in `prev`, is a `model-excluded` warning with the reason.

**Bucket objects**

- `catalogKeys` gives the object keys: `catalog/models.json`, `current.json`, `universe.json`, `notices.json`, `versions/<v>.json`, `changes/<v>.json` and `snapshots/20261116T030000Z.json` (compact UTC).
- `publishPointer(current, version, at, 'refresh' | 'deploy')` and `rollbackPointer(current, at, target?)` build `catalog/current.json`:
  - `previous` is the version the pointer replaced, and `history` holds the last 10 published versions, newest first.
  - Versions are immutable: `publishPointer` refuses a version that is not newer than every version in the history.
  - A rollback keeps the history and writes `by: 'rollback'`. Its default target is the version the last publish replaced (`previous`); from a rollback pointer it is the entry just older than the current version, so repeated rollbacks step further back.
- `NoticesObject` also carries the latest refresh's `outcome` (`published`, `unchanged`, `held`, `blocked`) and `mode` (`scheduled`, `manual`, `deploy`). With outcome `held` (the pointer was rolled back) it carries `held`, the diff the refresh would have published, and an `update-held` notice that lists the affected models.
- Each object has a validator, and each throws `CatalogError` listing every problem:
  - `CatalogPointer`: `validatePointer`
  - `ChangeLog`: `validateChangeLog`
  - `NoticesObject`: `validateNotices`
  - `UniverseObject`: `validateUniverse`
  - `CatalogSnapshot`: `validateSnapshot`

## Fixtures

`src/__fixtures__/` holds real responses from `global.anthropic.claude-haiku-5-5` and `global.openai.gpt-6-luna`, captured in ap-northeast-1 on 2026-11-04. Account ids, request ids and response ids are scrubbed.

To recapture (this makes a few dozen small, billed Bedrock calls):

```
uv run packages/pricing/scripts/capture_fixtures.py --region <aws-region> [messages|chat|responses|kimi ...]
```

- The Region comes from `--region`, else `AWS_REGION`; there is no default.
- With no dialect named it captures messages, chat and responses; `kimi` is opt-in.
- The script signs requests with botocore SigV4 and the default credential chain. It refuses to run unless the caller account is `LLMAR_SPIKE_ACCOUNT`; set that in your own untracked env file.
- Review the scrubbed fixtures before committing them.
