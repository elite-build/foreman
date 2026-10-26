// Types for the string catalogues (see index.ts).
import type { en } from './en'

/** Forms of a message that depends on `{count}`: Intl.PluralRules categories, plus `zero` for exactly 0. */
export type PluralMessage = { readonly [C in Intl.LDMLPluralRule]?: string } & { readonly other: string }

export type Message = string | PluralMessage

export type MessageKey = keyof typeof en

/** A locale's translations. Partial: a missing (or empty) key shows the English text. */
export type Catalogue = { readonly [K in MessageKey]?: Message }

export type ParamValue = string | number

// `{name}` placeholders in a message, as a union of names.
type Placeholders<S> = S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never
type ParamNames<M> = M extends string ? Placeholders<M> : 'count' | Placeholders<M[keyof M]>

export type MessageParams<K extends MessageKey> = { [P in ParamNames<(typeof en)[K]>]: ParamValue }

/** A key with no placeholders takes no params; one with placeholders needs all of them. */
export type TArgs<K extends MessageKey> = [ParamNames<(typeof en)[K]>] extends [never] ? [params?: undefined] : [params: MessageParams<K>]

export type TFunction = <K extends MessageKey>(key: K, ...args: TArgs<K>) => string

/** Keys that take no params, for tables of labels (`label: PlainKey`, then `t(row.label)`). */
export type PlainKey = { [K in MessageKey]: [ParamNames<(typeof en)[K]>] extends [never] ? K : never }[MessageKey]
