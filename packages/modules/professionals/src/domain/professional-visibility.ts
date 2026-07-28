export const ProfessionalVisibility = {
  PUBLIC: 'PUBLIC',
  SUPPRESSED: 'SUPPRESSED',
  MERGED: 'MERGED',
  ARCHIVED: 'ARCHIVED',
} as const;

export type ProfessionalVisibility =
  (typeof ProfessionalVisibility)[keyof typeof ProfessionalVisibility];
