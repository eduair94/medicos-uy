export class InvalidProfessionalQueryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidProfessionalQueryError';
  }
}

export class InvalidProfessionalCursorError extends Error {
  public constructor() {
    super('The professionals cursor is invalid or unsupported.');
    this.name = 'InvalidProfessionalCursorError';
  }
}

export class ProfessionalNotFoundError extends Error {
  public constructor() {
    super('Professional not found.');
    this.name = 'ProfessionalNotFoundError';
  }
}
