import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(values: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(values);
}
