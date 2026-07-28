import type {
  ProfessionalDiscoveryCoverage,
  ProfessionalSeed,
  WebEnrichmentCandidate,
} from '../domain/discovery-contracts';

export function buildCoverage(options: {
  readonly professionals: readonly ProfessionalSeed[];
  readonly candidates: readonly WebEnrichmentCandidate[];
  readonly sourceFailures: number;
  readonly restrictedPageCount: number;
  readonly plannedSourcePages: number;
  readonly completedSourcePages: number;
  readonly professionalSnapshotSha256: string;
  readonly sourcePolicySha256: string;
  readonly observedAt: string;
}): readonly ProfessionalDiscoveryCoverage[] {
  const candidateCounts = new Map<string, number>();
  for (const candidate of options.candidates) {
    const id = candidate.subject.opaqueProfessionalId;
    candidateCounts.set(id, (candidateCounts.get(id) ?? 0) + 1);
  }

  return options.professionals.map((professional) => {
    const candidateCount = candidateCounts.get(professional.opaqueProfessionalId) ?? 0;
    const status =
      options.sourceFailures > 0
        ? 'PARTIAL_SOURCE_FAILURE'
        : options.restrictedPageCount > 0
          ? 'BLOCKED_BY_SOURCE_POLICY'
          : candidateCount > 0
            ? 'COMPLETE_CONFIGURED_SCOPE'
            : 'NO_CANDIDATE_WITHIN_CONFIGURED_SCOPE';
    return {
      schemaVersion: 1,
      opaqueProfessionalId: professional.opaqueProfessionalId,
      professionalSnapshotSha256: options.professionalSnapshotSha256,
      sourcePolicySha256: options.sourcePolicySha256,
      status,
      candidateCount,
      plannedSourcePages: options.plannedSourcePages,
      completedSourcePages: options.completedSourcePages,
      lastAttemptAt: options.observedAt,
      noFindingsProvesAbsence: false,
      publicExportAllowed: false,
    };
  });
}
