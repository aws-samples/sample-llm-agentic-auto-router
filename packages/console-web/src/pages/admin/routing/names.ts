// Display names and prices for model ids (design §6.4). The catalog carries no product names, so the name comes from
// the id: region / geo prefix and vendor removed, version digits joined with dots ("Sonnet 5.5", "GPT-6.1 Sol").

import type { CatalogModelView } from '@auto-router/console-contract'
import { baseModelId } from './model.ts'

const title = (w: string) => (w ? (w[0] as string).toUpperCase() + w.slice(1) : w)

export function modelName(id: string): string {
  const rest = baseModelId(id).replace(/^[a-z0-9]+\./, '').replace(/(-\d{8})?(-v\d+(:\d+)?)?$/, '')
  if (rest === '' || !/^[a-z0-9.-]+$/.test(rest)) return id.replace(/^global\./, '')
  const parts = rest.split('-')
  if (parts[0] === 'claude') parts.shift()
  if (parts[0] === 'gpt' && parts[1] !== undefined) {
    const [, v, ...tail] = parts
    return [`GPT-${v}`, ...tail.map(title)].join(' ')
  }
  const out: string[] = []
  for (const p of parts) {
    const prev = out[out.length - 1]
    if (/^\d+$/.test(p) && prev !== undefined && /^\d+(\.\d+)*$/.test(prev)) out[out.length - 1] = `${prev}.${p}`
    else out.push(/^\d/.test(p) ? p : title(p))
  }
  return out.join(' ')
}

/** List price per 1M tokens, or undefined when the catalog view has none. */
export function priceOf(catalog: CatalogModelView[], id: string): { input: number; output: number } | undefined {
  return catalog.find((x) => x.modelId === id)?.price
}

/** The catalog's non-default service tier of a model (flex / priority), or undefined for the default tier. */
export function serviceTierOf(catalog: CatalogModelView[], id: string): string | undefined {
  const st = catalog.find((x) => x.modelId === id)?.serviceTier
  return st && st !== 'default' ? st : undefined
}

/** "$2" / "$0.1" / "$0.0007": at most 4 decimals, no trailing zeros. */
export const dollars = (n: number): string => `$${Number(n.toFixed(4)).toString()}`
