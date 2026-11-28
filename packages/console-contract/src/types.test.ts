// Type-level checks of additive contract fields (no runtime behaviour): older responses without them stay valid.
import { describe, expectTypeOf, it } from 'vitest'
import type { AuditAction, CatalogAuditAction, RecordDetail, SavingsBlock, SavingsReport } from './index.ts'

describe('contract types', () => {
  it('SavingsReport.projectedAssessed: an optional block with differing, changed and total', () => {
    expectTypeOf<SavingsReport['projectedAssessed']>().toEqualTypeOf<(SavingsBlock & { differing: number; changed: number; total: number }) | undefined>()
    expectTypeOf<Omit<SavingsReport, 'projectedAssessed'>>().toExtend<Omit<SavingsReport, 'projectedAssessed'>>()
  })

  it('RecordDetail.decision.projectedAssessed has the projected shape and is optional', () => {
    type D = NonNullable<RecordDetail['decision']>
    expectTypeOf<D['projectedAssessed']>().toEqualTypeOf<{ model: string; switch: boolean } | undefined>()
    expectTypeOf<D['projectedAssessed']>().toEqualTypeOf<D['projected']>()
  })

  it('AuditAction includes the dynamic-catalog actions (C4 has their copy)', () => {
    expectTypeOf<CatalogAuditAction>().toExtend<AuditAction>()
    expectTypeOf<'model.confirm'>().toExtend<AuditAction>()
  })
})

describe('admin assessor rule fields (task 11-18)', () => {
  it('are optional additions', async () => {
    type A = import('./index.ts').AssessorRecord
    type S = import('./index.ts').ActiveAssessorSettings
    type T = import('./index.ts').TranslateRulesResponse
    expectTypeOf<A['custom']>().toEqualTypeOf<Record<string, string> | undefined>()
    expectTypeOf<A['prev']>().toEqualTypeOf<{ tier: import('./index.ts').Tier; mark?: string[] } | undefined>()
    expectTypeOf<S['customRules']>().toEqualTypeOf<import('./index.ts').CustomRuleView[] | undefined>()
    expectTypeOf<T['assessorRules']>().toEqualTypeOf<import('./index.ts').TranslatedAssessorRule[] | undefined>()
  })
})

describe('console-managed providers (ADR 0002)', () => {
  it('the providers section is optional, and the key status never carries a key', () => {
    type D = import('./index.ts').ConfigDocument
    expectTypeOf<D['providers']>().toEqualTypeOf<import('./index.ts').ProvidersSectionDoc | undefined>()
    expectTypeOf<import('./index.ts').ProviderKeyStatus>().toEqualTypeOf<{ set: boolean; updatedAt?: string }>()
    expectTypeOf<'provider.key.set' | 'provider.key.delete'>().toExtend<AuditAction>()
    expectTypeOf<'providers'>().toExtend<import('./index.ts').ConfigSectionName>()
  })
})
