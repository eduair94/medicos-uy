export class InvalidOwnerResearchQueryError extends Error {
  public constructor() {
    super('The professional identifier is invalid.');
    this.name = 'InvalidOwnerResearchQueryError';
  }
}

export class OwnerResearchNotFoundError extends Error {
  public constructor() {
    super('No current private research dossier was found for the professional.');
    this.name = 'OwnerResearchNotFoundError';
  }
}

export class OwnerResearchDataIntegrityError extends Error {
  public constructor() {
    super('The current private research dossier does not satisfy the API contract.');
    this.name = 'OwnerResearchDataIntegrityError';
  }
}
