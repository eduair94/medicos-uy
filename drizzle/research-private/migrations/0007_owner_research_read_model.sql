BEGIN;

/*
 * Authenticated owner research read model.
 *
 * This view deliberately remains outside the public catalog views. It exposes
 * only the current, successfully persisted dossier for professionals that are
 * still visible in the MSP-backed catalog, and it resolves both current and
 * historical public slugs. The SQL projection removes internal identifiers,
 * filesystem paths and artifact hashes before the API role can read the JSON.
 *
 * The API login role receives no access to the underlying ingestion/research
 * tables. PostgreSQL evaluates this (default security-definer) view with the
 * view owner's rights, while security_barrier prevents caller predicates from
 * being pushed through the privacy boundary.
 */

CREATE OR REPLACE FUNCTION research_private.owner_jsonb_pick(
  input jsonb,
  allowed_keys text[]
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT COALESCE(
    jsonb_object_agg(entry.key, entry.value ORDER BY entry.key),
    '{}'::jsonb
  )
  FROM jsonb_each(input) AS entry
  WHERE entry.key = ANY (allowed_keys);
$function$;

CREATE OR REPLACE FUNCTION research_private.sanitize_owner_research_view(
  input jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT
    research_private.owner_jsonb_pick(
      input,
      ARRAY[
        'schemaVersion',
        'reportId',
        'generatedAt',
        'purpose',
        'warnings'
      ]
    )
    || jsonb_build_object(
      'query',
      research_private.owner_jsonb_pick(
        input -> 'query',
        ARRAY[
          'mode',
          'selectionRule',
          'bestFlexibilityIndex',
          'ambiguity'
        ]
      ),
      'candidates',
      COALESCE(
        (
          SELECT jsonb_agg(
            research_private.owner_jsonb_pick(
              candidate,
              ARRAY[]::text[]
            )
            || jsonb_build_object(
              'professional',
              research_private.owner_jsonb_pick(
                candidate -> 'professional',
                ARRAY['fullName']
              )
              || jsonb_build_object(
                'enabledTitles',
                COALESCE(
                  (
                    SELECT jsonb_agg(
                      research_private.owner_jsonb_pick(
                        title,
                        ARRAY['title', 'temporaryRegistration']
                      )
                      ORDER BY title_order
                    )
                    FROM jsonb_array_elements(
                      candidate #> '{professional,enabledTitles}'
                    ) WITH ORDINALITY AS titles(title, title_order)
                  ),
                  '[]'::jsonb
                ),
                'provenance',
                research_private.owner_jsonb_pick(
                  candidate #> '{professional,provenance}',
                  ARRAY['publisher', 'dataset', 'sourceCutoffDate']
                )
              ),
              'queryMatch',
              research_private.owner_jsonb_pick(
                candidate -> 'queryMatch',
                ARRAY[
                  'kind',
                  'flexibilityIndex',
                  'canonicalTokenCount',
                  'observedTokenCount',
                  'exactObservedTokenCount',
                  'initialObservedTokenCount',
                  'meaning'
                ]
              ),
              'institutionalCandidates',
              COALESCE(
                (
                  SELECT jsonb_agg(
                    research_private.owner_jsonb_pick(
                      institution,
                      ARRAY[
                        'candidateId',
                        'institution',
                        'status',
                        'sourceDisplayNames',
                        'sourceSpecialties',
                        'identityEvidence',
                        'identityConfirmed',
                        'linkageDecision',
                        'publicationDecision',
                        'requiresHumanReview',
                        'alerts'
                      ]
                    )
                    || jsonb_build_object(
                      'providerIdentity',
                      research_private.owner_jsonb_pick(
                        institution -> 'providerIdentity',
                        ARRAY[
                          'institution',
                          'basis',
                          'sourceProfessionalId',
                          'normalizedName'
                        ]
                      ),
                      'unresolvedSourceRecords',
                      COALESCE(
                        (
                          SELECT jsonb_agg(
                            research_private.owner_jsonb_pick(
                              source_record,
                              ARRAY['recordId']
                            )
                            ORDER BY source_record_order
                          )
                          FROM jsonb_array_elements(
                            institution -> 'unresolvedSourceRecords'
                          ) WITH ORDINALITY AS source_records(
                            source_record,
                            source_record_order
                          )
                        ),
                        '[]'::jsonb
                      ),
                      'schedules',
                      COALESCE(
                        (
                          SELECT jsonb_agg(
                            research_private.owner_jsonb_pick(
                              schedule,
                              ARRAY[
                                'schemaVersion',
                                'recordId',
                                'observedAt',
                                'scheduleType',
                                'appointmentAvailability',
                                'sourceProfessionalId',
                                'sourceProfessionalLabel',
                                'professionalName',
                                'specialty',
                                'frequency',
                                'notes'
                              ]
                            )
                            || jsonb_build_object(
                              'source',
                              research_private.owner_jsonb_pick(
                                schedule -> 'source',
                                ARRAY['id', 'institution', 'url']
                              ),
                              'venue',
                              research_private.owner_jsonb_pick(
                                schedule -> 'venue',
                                ARRAY['name', 'address', 'phone', 'dependency']
                              ),
                              'weeklySchedule',
                              COALESCE(
                                (
                                  SELECT jsonb_agg(
                                    research_private.owner_jsonb_pick(
                                      weekly_entry,
                                      ARRAY['dayOfWeek', 'sourceLabel', 'value']
                                    )
                                    ORDER BY weekly_entry_order
                                  )
                                  FROM jsonb_array_elements(
                                    schedule -> 'weeklySchedule'
                                  ) WITH ORDINALITY AS weekly_entries(
                                    weekly_entry,
                                    weekly_entry_order
                                  )
                                ),
                                '[]'::jsonb
                              )
                            )
                            ORDER BY schedule_order
                          )
                          FROM jsonb_array_elements(
                            institution -> 'schedules'
                          ) WITH ORDINALITY AS schedules(schedule, schedule_order)
                        ),
                        '[]'::jsonb
                      )
                    )
                    ORDER BY institution_order
                  )
                  FROM jsonb_array_elements(
                    candidate -> 'institutionalCandidates'
                  ) WITH ORDINALITY AS institutions(institution, institution_order)
                ),
                '[]'::jsonb
              ),
              'webCandidates',
              COALESCE(
                (
                  SELECT jsonb_agg(
                    research_private.owner_jsonb_pick(
                      web_candidate,
                      ARRAY[
                        'schemaVersion',
                        'candidateId',
                        'state',
                        'quarantine'
                      ]
                    )
                    || jsonb_build_object(
                      'subject',
                      research_private.owner_jsonb_pick(
                        web_candidate -> 'subject',
                        ARRAY['displayName']
                      ),
                      'claim',
                      research_private.owner_jsonb_pick(
                        web_candidate -> 'claim',
                        ARRAY['category', 'sourceId', 'publisher']
                      ),
                      'match',
                      research_private.owner_jsonb_pick(
                        web_candidate -> 'match',
                        ARRAY[
                          'kind',
                          'flexibilityIndex',
                          'meaning',
                          'ambiguity',
                          'alerts'
                        ]
                      ),
                      'provenance',
                      research_private.owner_jsonb_pick(
                        web_candidate -> 'provenance',
                        ARRAY['canonicalUrl', 'retrievedAt', 'transport']
                      ),
                      'linkageDecision',
                      research_private.owner_jsonb_pick(
                        web_candidate -> 'linkageDecision',
                        ARRAY['decision', 'identityConfirmed']
                      ),
                      'factDecision',
                      research_private.owner_jsonb_pick(
                        web_candidate -> 'factDecision',
                        ARRAY['factConfirmed']
                      ),
                      'publicationDecision',
                      research_private.owner_jsonb_pick(
                        web_candidate -> 'publicationDecision',
                        ARRAY[
                          'decision',
                          'destination',
                          'publicExportAllowed'
                        ]
                      ),
                      'retention',
                      research_private.owner_jsonb_pick(
                        web_candidate -> 'retention',
                        ARRAY['expiresAt', 'disposition']
                      )
                    )
                    ORDER BY web_candidate_order
                  )
                  FROM jsonb_array_elements(
                    candidate -> 'webCandidates'
                  ) WITH ORDINALITY AS web_candidates(
                    web_candidate,
                    web_candidate_order
                  )
                ),
                '[]'::jsonb
              ),
              'publicReferenceCandidates',
              COALESCE(
                (
                  SELECT jsonb_agg(
                    research_private.owner_jsonb_pick(
                      reference_candidate,
                      ARRAY['connection', 'alerts']
                    )
                    || jsonb_build_object(
                      'reference',
                      research_private.owner_jsonb_pick(
                        reference_candidate -> 'reference',
                        ARRAY[
                          'schemaVersion',
                          'referenceId',
                          'referenceKind',
                          'publisher',
                          'canonicalUrl',
                          'title',
                          'sourceDate',
                          'sourceDatePrecision',
                          'observedNames',
                          'corroboratesReferenceIds'
                        ]
                      )
                      || jsonb_build_object(
                        'claim',
                        research_private.owner_jsonb_pick(
                          reference_candidate #> '{reference,claim}',
                          ARRAY[
                            'relationship',
                            'factualSummary',
                            'institutionContext',
                            'doesNotEstablish'
                          ]
                        ),
                        'access',
                        research_private.owner_jsonb_pick(
                          reference_candidate #> '{reference,access}',
                          ARRAY[
                            'mode',
                            'automatedFetchAllowed',
                            'contentStored',
                            'rightsNote'
                          ]
                        ),
                        'decision',
                        research_private.owner_jsonb_pick(
                          reference_candidate #> '{reference,decision}',
                          ARRAY[
                            'identityConfirmed',
                            'factConfirmed',
                            'linkageDecision',
                            'publicationDecision',
                            'publicExportAllowed',
                            'requiresHumanReview'
                          ]
                        )
                      ),
                      'nameMatch',
                      CASE
                        WHEN jsonb_typeof(
                          reference_candidate -> 'nameMatch'
                        ) = 'object'
                        THEN research_private.owner_jsonb_pick(
                          reference_candidate -> 'nameMatch',
                          ARRAY[
                            'kind',
                            'flexibilityIndex',
                            'canonicalTokenCount',
                            'observedTokenCount',
                            'exactObservedTokenCount',
                            'initialObservedTokenCount',
                            'meaning'
                          ]
                        )
                        ELSE 'null'::jsonb
                      END
                    )
                    ORDER BY reference_candidate_order
                  )
                  FROM jsonb_array_elements(
                    candidate -> 'publicReferenceCandidates'
                  ) WITH ORDINALITY AS reference_candidates(
                    reference_candidate,
                    reference_candidate_order
                  )
                ),
                '[]'::jsonb
              ),
              'sourceCoverage',
              COALESCE(
                (
                  SELECT jsonb_agg(
                    research_private.owner_jsonb_pick(
                      source_coverage,
                      ARRAY[
                        'sourceId',
                        'publisher',
                        'sourceUrl',
                        'category',
                        'status',
                        'policyReviewedAt',
                        'automatedFetchPerformed',
                        'namedMatchStatus',
                        'noFindingProvesAbsence',
                        'identityDecision',
                        'publicationDecision',
                        'warnings'
                      ]
                    )
                    ORDER BY source_coverage_order
                  )
                  FROM jsonb_array_elements(
                    candidate -> 'sourceCoverage'
                  ) WITH ORDINALITY AS source_coverages(
                    source_coverage,
                    source_coverage_order
                  )
                ),
                '[]'::jsonb
              ),
              'signalSummary',
              research_private.owner_jsonb_pick(
                candidate -> 'signalSummary',
                ARRAY[
                  'officialRegistryRecords',
                  'institutionalCandidates',
                  'scheduleRecords',
                  'webCandidates',
                  'publicReferenceCandidates',
                  'publishers',
                  'institutionContexts'
                ]
              )
            )
            ORDER BY candidate_order
          )
          FROM jsonb_array_elements(input -> 'candidates')
            WITH ORDINALITY AS candidates(candidate, candidate_order)
        ),
        '[]'::jsonb
      ),
      'coverage',
      research_private.owner_jsonb_pick(
        input -> 'coverage',
        ARRAY[
          'mspSnapshotChecked',
          'linkageSnapshotChecked',
          'scheduleArtifactsChecked',
          'webEnrichmentSnapshotChecked',
          'curatedReferenceLedgerChecked',
          'noFindingsProvesAbsence'
        ]
      ),
      'delivery',
      research_private.owner_jsonb_pick(
        input -> 'delivery',
        ARRAY[
          'intendedSurface',
          'intendedAudience',
          'canonicalUrlsIncluded',
          'privateApiDeliveryAllowed',
          'publicApiDeliveryAllowed',
          'authenticationEnforcedBy'
        ]
      ),
      'publication',
      research_private.owner_jsonb_pick(
        input -> 'publication',
        ARRAY[
          'decision',
          'destination',
          'publicExportAllowed',
          'automaticIdentityConfirmation',
          'automaticFactConfirmation'
        ]
      )
    );
$function$;

DROP VIEW IF EXISTS research_private.owner_professional_dossier;

CREATE VIEW research_private.owner_professional_dossier
WITH (security_barrier = true)
AS
SELECT
  identity.professional_public_id,
  route.slug AS route_slug,
  route.route_kind,
  run.analysis_version,
  run.status AS run_status,
  dossier.report_id,
  dossier.generated_at,
  dossier.query_ambiguity,
  dossier.best_flexibility_index,
  dossier.candidate_count,
  dossier.official_registry_record_count,
  dossier.institutional_candidate_count,
  dossier.schedule_record_count,
  dossier.web_candidate_count,
  dossier.public_reference_candidate_count,
  dossier.ethics_candidate_count,
  research_private.sanitize_owner_research_view(dossier.research_view) AS research_view
FROM ingestion_private.msp_catalog_identity AS identity
INNER JOIN catalog.public_professional AS professional
  ON professional.id = identity.professional_public_id
INNER JOIN catalog.public_professional_route AS route
  ON route.professional_id = identity.professional_public_id
INNER JOIN research_private.current_professional_dossier AS current_dossier
  ON current_dossier.internal_hmac_id = identity.internal_hmac_id
INNER JOIN research_private.professional_dossier AS dossier
  ON dossier.internal_hmac_id = identity.internal_hmac_id
  AND dossier.run_id = current_dossier.run_id
INNER JOIN research_private.analysis_run AS run
  ON run.run_id = dossier.run_id
INNER JOIN research_private.work_item AS work_item
  ON work_item.run_id = dossier.run_id
  AND work_item.internal_hmac_id = dossier.internal_hmac_id
WHERE work_item.status = 'SUCCEEDED'
  AND run.status IN ('COMPLETED', 'PARTIAL');

REVOKE ALL ON research_private.owner_professional_dossier
  FROM
    PUBLIC,
    medicos_catalog_reader,
    medicos_public_query,
    medicos_private_ingestor,
    medicos_owner_research_reader;

REVOKE ALL ON FUNCTION research_private.sanitize_owner_research_view(jsonb)
  FROM
    PUBLIC,
    medicos_catalog_reader,
    medicos_public_query,
    medicos_private_ingestor,
    medicos_owner_research_reader;

REVOKE ALL ON FUNCTION research_private.owner_jsonb_pick(jsonb, text[])
  FROM
    PUBLIC,
    medicos_catalog_reader,
    medicos_public_query,
    medicos_private_ingestor,
    medicos_owner_research_reader;

REVOKE USAGE ON SCHEMA research_private
  FROM medicos_catalog_reader, medicos_public_query;

GRANT USAGE ON SCHEMA research_private TO medicos_owner_research_reader;
-- Both functions are immutable projections over caller-supplied JSON and read
-- no relations. PostgreSQL checks function EXECUTE privileges as the view
-- caller, so the reader needs these grants to select the sanitized column.
GRANT EXECUTE ON FUNCTION research_private.owner_jsonb_pick(jsonb, text[])
  TO medicos_owner_research_reader;
GRANT EXECUTE ON FUNCTION research_private.sanitize_owner_research_view(jsonb)
  TO medicos_owner_research_reader;
GRANT SELECT ON research_private.owner_professional_dossier
  TO medicos_owner_research_reader;

COMMIT;
