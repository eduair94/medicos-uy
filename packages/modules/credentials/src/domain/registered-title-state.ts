export const REGISTERED_TITLE_STATES = [
  'ENABLED',
  'DISABLED',
  'UNDER_REVIEW',
  'WITHDRAWN',
] as const;

export type RegisteredTitleState = (typeof REGISTERED_TITLE_STATES)[number];

export const TEMPORARY_REGISTRATION_KINDS = ['NONE', 'WITH_CONTRACT', 'WITHOUT_CONTRACT'] as const;

export type TemporaryRegistrationKind = (typeof TEMPORARY_REGISTRATION_KINDS)[number];
