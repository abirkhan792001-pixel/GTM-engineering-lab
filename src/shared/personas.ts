import { z } from 'zod';
import { readContextFile } from './profile';

// Typed, validated view of personas.json (src/context/, or the GTM_PROFILE folder).

const Count = z.number().int().nonnegative();

export const PersonaSchema = z.strictObject({
  id: z.string().min(1),
  targetTitles: z.array(z.string().min(1)).min(1),
  seniority: z.array(z.string().min(1)),
  headcountRange: z.strictObject({ min: Count.optional(), max: Count.optional() }).optional(),
  painPoints: z.array(z.string().min(1)).min(1),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const PersonasSchema = z.strictObject({
  version: z.string().min(1),
  description: z.string(),
  personas: z.array(PersonaSchema).min(1),
  excludedTitles: z.array(z.string().min(1)),
});
export type Personas = z.infer<typeof PersonasSchema>;

export function parsePersonas(json: string, label = 'personas.json'): Personas {
  const parsed = PersonasSchema.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error(`${label} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export const PERSONAS: Personas = parsePersonas(readContextFile('personas.json'));

// First persona whose headcount range contains the account; the first persona if headcount is unknown.
export function selectPersona(headcount: number | null, personas: Persona[] = PERSONAS.personas): Persona {
  const match =
    headcount === null
      ? undefined
      : personas.find(p => (p.headcountRange?.min ?? 0) <= headcount && headcount <= (p.headcountRange?.max ?? Infinity));
  return match ?? personas[0]!;
}
