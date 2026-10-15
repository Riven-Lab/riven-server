import { z } from "zod";

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const ingestionEventSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/),
  properties: z.record(z.string(), jsonValueSchema).default({}),
  timestamp: z.string().datetime({ offset: true })
}).strict();

export type IngestionEvent = z.infer<typeof ingestionEventSchema>;
