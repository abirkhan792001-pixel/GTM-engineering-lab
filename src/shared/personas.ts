import { z } from 'zod';
import personasJson from '../context/personas.json';

// Typed, validated view of src/context/personas.json.

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

export const PERSONAS: Personas = PersonasSchema.parse(personasJson);

// First persona whose headcount range contains the account; the first persona if headcount is unknown.
export function selectPersona(headcount: number | null, personas: Persona[] = PERSONAS.personas): Persona {
  const match =
    headcount === null
      ? undefined
      : personas.find(p => (p.headcountRange?.min ?? 0) <= headcount && headcount <= (p.headcountRange?.max ?? Infinity));
  return match ?? personas[0]!;
}
