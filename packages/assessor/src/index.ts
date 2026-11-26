// @auto-router/assessor public API (design §9).
export type { AssessorResult, CardContext, Tier, TierAssessor } from './contract.ts'
export { TIERS } from './contract.ts'
export { buildCard, CARD_LIMITS, CARD_VERSIONS, cardUserTexts, cut, cutTail, isCardVersion, isTaskCard, outputFailed, sanitize, stripSystemReminders, taskCardIssue, type CardBuildContext, type CardVersion, type CutText, type TaskCard } from './card.ts'
export { CUSTOM_RULE_LIMITS, PRESET_CUSTOM_RULES, validateCustomRules, type CustomRule, type CustomRuleState, type CustomRulesResult } from './custom.ts'
export {
  adminSection, cardJson, defaultPackDir, LEARNED_LIMITS, defaultPackName, isPackName, loadPack, packDirs, PACK_LIMITS, PackError, renderPrompt, renderSystem, ruleHash, rulesVersionOf, validatePack,
  type Pack, type PackExample, type PackName, type PackRule, type RenderedPrompt,
} from './pack.ts'
export { outputSchema, REASONING_DEPTHS, SCOPES, SPECIFICATIONS, type JsonSchema } from './schema.ts'
export { validateAssessment, VALIDATION_LIMITS, type Assessment, type RuleAssessment, type TaskFacts, type ValidationResult } from './validate.ts'
export { boundaryHashes, createTemplateMemory, processTemplateMemory, TEMPLATE_LIMITS, type TemplateLimits, type TemplateMemory, type TemplateScope } from './template.ts'
export { cardFeaturesOf, DEFAULT_MAPPING, DEFAULT_THRESHOLD, FACT_SIGNALS, LEARNED_FEATURES, LEARNED_TIERS, learnedFeature, learnedScore, mapTier, type CardFeatures, type FactSignal, type LearnedHead, type LearnedMapping, type RequestFeatures, type MapOptions, type MapOutcome, type PackMapping, type TierMapping } from './map.ts'
export {
  anthropicMessagesAdapter, BEDROCK_ANTHROPIC_VERSION, openAiChatAdapter, openAiResponsesAdapter, SCHEMA_NAME, selectAdapter, TOOL_NAME,
  type AdapterCfg, type BuildParams, type ModelAdapter, type OpenAiApi, type ParseResult,
} from './adapters/index.ts'
export { fakeTransport, type FakeStep, type FakeTransport, type Transport, type TransportRequest, type TransportResponse } from './transport.ts'
export {
  createAssessor, DEFAULT_ASSESSOR_MODEL, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_REASONING_EFFORT, DEFAULT_TIMEOUT_MS, precheck, scrub, servedServiceTier, withServiceTier,
  type Assessor, type AssessorCallInfo, type AssessorConfig,
} from './assessor.ts'
export {
  buildManifest, writePacksArchive, loadBundledPacks, manifestEntry, manifestMismatches, manifestPath, manifestText, MANIFEST_SCHEMA_VERSION, readManifest,
  type BundledPack, type ManifestPack, type PackManifest,
} from './manifest.ts'
