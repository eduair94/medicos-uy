import { STATUS_CODES } from 'node:http';

import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';

import type { FastifyReply, FastifyRequest } from 'fastify';

interface HttpExceptionBody {
  readonly error?: string;
  readonly message?: string | readonly string[];
}

interface HttpStatusCodeError {
  readonly statusCode: number;
}

interface ProblemDetails {
  readonly type: 'about:blank';
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly traceId: string;
  readonly errors?: readonly string[];
}

function isHttpExceptionBody(value: unknown): value is HttpExceptionBody {
  return typeof value === 'object' && value !== null;
}

function isHttpStatusCodeError(value: unknown): value is HttpStatusCodeError {
  if (typeof value !== 'object' || value === null || !('statusCode' in value)) {
    return false;
  }

  const statusCode = value.statusCode;
  return (
    typeof statusCode === 'number' &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode <= 599
  );
}

function exceptionDetail(exception: HttpException): {
  readonly detail: string;
  readonly errors?: readonly string[];
} {
  const response = exception.getResponse();

  if (typeof response === 'string') {
    return {
      detail: response,
    };
  }

  if (!isHttpExceptionBody(response)) {
    return {
      detail: 'The request could not be processed.',
    };
  }

  if (typeof response.message === 'string') {
    return {
      detail: response.message,
    };
  }

  if (Array.isArray(response.message)) {
    return {
      detail: 'One or more request fields are invalid.',
      errors: response.message,
    };
  }

  return {
    detail: response.error ?? 'The request could not be processed.',
  };
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  public catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const isHttpException = exception instanceof HttpException;
    const isStatusCodeError = isHttpStatusCodeError(exception);
    const status = isHttpException
      ? exception.getStatus()
      : isStatusCodeError
        ? exception.statusCode
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const knownDetails = isHttpException
      ? exceptionDetail(exception)
      : status === 429
        ? {
            detail: 'Too many requests.',
          }
        : {
            detail: 'An unexpected error occurred.',
          };

    if (!isHttpException && (!isStatusCodeError || status >= 500)) {
      this.logger.error(
        {
          errorType: exception instanceof Error ? exception.name : 'UnknownError',
          traceId: request.id,
        },
        'Unhandled request error',
      );
    }

    const problem: ProblemDetails = {
      type: 'about:blank',
      title: STATUS_CODES[status] ?? 'Error',
      status,
      detail: knownDetails.detail,
      instance: request.url,
      traceId: request.id,
      ...(knownDetails.errors === undefined ? {} : { errors: knownDetails.errors }),
    };

    void reply.status(status).type('application/problem+json').send(problem);
  }
}
