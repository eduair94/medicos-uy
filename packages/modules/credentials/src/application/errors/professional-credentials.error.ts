export class InvalidProfessionalCredentialsQueryError extends Error {
  public constructor() {
    super('The professional identifier is invalid.');
    this.name = 'InvalidProfessionalCredentialsQueryError';
  }
}

export class ProfessionalCredentialsNotFoundError extends Error {
  public constructor() {
    super('Public professional credentials were not found.');
    this.name = 'ProfessionalCredentialsNotFoundError';
  }
}
