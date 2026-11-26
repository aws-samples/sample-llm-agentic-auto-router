// Defaults shared by console-api, console-web and its mock API, so the three cannot drift.
import type { Baseline } from './types.ts'

/**
 * Savings baseline when the deployment setting `defaultBaseline` is not stored. Frontier: against the requested
 * tier (usually the pool's default, standard) the saving stays small while routing keeps most traffic on that tier,
 * so the default compares with what the same traffic would cost on the frontier model. A stored setting always wins; admins can switch back on Settings.
 */
export const DEFAULT_BASELINE: Baseline = 'frontier'
