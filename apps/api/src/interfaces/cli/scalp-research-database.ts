export function requireIsolatedResearchDatabaseUrl(operationalUrl: string, researchUrl: string | undefined): string {
  if (!researchUrl) throw new Error("SCALP_RESEARCH_DATABASE_URL is required for the physically isolated harness.");
  const operational = new URL(operationalUrl);
  const research = new URL(researchUrl);
  if (operational.username === research.username) {
    throw new Error("SCALP_RESEARCH_DATABASE_URL must use a different, least-privilege database role.");
  }
  return researchUrl;
}
