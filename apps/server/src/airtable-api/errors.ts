import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@riosoma/contracts';
import { ZodError } from 'zod';
import { message } from '../api-v1/messages.js';

/**
 * Errors in the shape Airtable's Web API answers with, `{"error": {"type": …, "message": …}}`,
 * with Airtable's types and status codes, so client libraries and scripts written against it read
 * them the way they always have.
 */
export class AirtableError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AirtableError';
  }

  params: AppError['params'];
  conflicts: AppError['conflicts'];

  body() {
    return {
      error: {
        type: this.type,
        message: this.message,
        ...(this.params ? { params: this.params } : {}),
        ...(this.fields ? { fields: this.fields } : {}),
        ...(this.conflicts ? { conflicts: this.conflicts } : {}),
      },
    };
  }
}

export const authenticationRequired = () =>
  new AirtableError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');

/** Airtable says this for a base or table the token can't reach, whether or not it exists. */
export const modelNotFound = () =>
  new AirtableError(
    403,
    'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND',
    'Invalid permissions, or the requested model was not found. Check that both your user and your token have the required permissions, and that the model names and/or ids are correct.',
  );

export const notPermitted = () =>
  new AirtableError(
    403,
    'INVALID_PERMISSIONS',
    'You are not permitted to perform this operation because the field or table has been configured to limit who can perform this operation',
  );

export const notFound = () => new AirtableError(404, 'NOT_FOUND', 'Could not find what you are looking for');

export const invalidRequest = (
  text = 'Invalid request: parameter validation failed. Check your request data.',
) => new AirtableError(422, 'INVALID_REQUEST_UNKNOWN', text);

export const invalidRecords = (text: string) => new AirtableError(422, 'INVALID_RECORDS', text);

export const missingFields = () =>
  new AirtableError(
    422,
    'INVALID_REQUEST_MISSING_FIELDS',
    'Could not find field "fields" in the request body',
  );

export const unknownField = (name: string) =>
  new AirtableError(422, 'UNKNOWN_FIELD_NAME', `Unknown field name: "${name}"`);

export const viewNotFound = (name: string) =>
  new AirtableError(422, 'VIEW_NAME_NOT_FOUND', `View "${name}" not found`);

export const rowMissing = (id: string) =>
  new AirtableError(422, 'ROW_DOES_NOT_EXIST', `Record ID ${id} does not exist in this table`);

/** Airtable's answer for a value sent to a field that can't take one, here for one this API can't write. */
export const readOnlyField = (name: string) =>
  new AirtableError(
    422,
    'INVALID_VALUE_FOR_COLUMN',
    `Field "${name}" cannot accept a value because the field is read-only through this API`,
  );

export const invalidFormula = (detail: string) =>
  new AirtableError(
    422,
    'INVALID_FILTER_BY_FORMULA',
    `The formula for filtering records is invalid: ${detail}`,
  );

export const iteratorGone = () =>
  new AirtableError(
    422,
    'LIST_RECORDS_ITERATOR_NOT_AVAILABLE',
    'The offset is no longer valid.  Start listing again without it.',
  );

export const rateLimited = () =>
  new AirtableError(429, 'RATE_LIMIT_REACHED', 'Rate limit exceeded. Please try again later');

function fieldOf(error: AppError): string {
  const field = error.params?.field;
  return typeof field === 'string' ? field : '';
}

/** Riosoma's own errors, from the code shared with the REST API, in Airtable's terms. */
function mappedError(error: AppError): AirtableError {
  if (error.conflicts) return new AirtableError(409, 'TEXT_CONFLICT', message(error.messageKey));
  if (error.fields)
    return new AirtableError(
      error.status,
      'INVALID_VALUE_FOR_COLUMN',
      message(error.messageKey),
      error.fields,
    );
  const field = fieldOf(error);
  switch (error.messageKey) {
    case 'errors.tokenInvalid':
      return authenticationRequired();
    case 'errors.tokenScope':
      return modelNotFound();
    case 'api.cursor.invalid':
      return iteratorGone();
    case 'data.value.unknownChoice':
      return typeof error.params?.value === 'string'
        ? new AirtableError(
            422,
            'INVALID_MULTIPLE_CHOICE_OPTIONS',
            `Insufficient permissions to create new select option ""${error.params.value}""`,
          )
        : new AirtableError(
            422,
            'INVALID_VALUE_FOR_COLUMN',
            `Field "${field}" cannot accept the provided value`,
          );
    case 'data.value.aiField':
      return new AirtableError(
        422,
        'INVALID_VALUE_FOR_COLUMN',
        `Field "${field}" cannot accept a value because its model fills it in.  Send "overrideAiFields": true to write it anyway`,
      );
    case 'data.value.computed':
    case 'data.value.button':
      return new AirtableError(
        422,
        'INVALID_VALUE_FOR_COLUMN',
        `Field "${field}" cannot accept a value because the field is computed`,
      );
    case 'data.link.unknownRecord':
      return new AirtableError(
        422,
        'ROW_DOES_NOT_EXIST',
        `A record that field "${field}" links to does not exist in its table`,
      );
    case 'data.access.fieldLocked':
    case 'data.access.denied':
      return notPermitted();
    case 'sources.live.viewUnsupported':
      return invalidRequest('This table reads its records live from their source, which this API can’t read');
  }
  if (error.messageKey.startsWith('api.file.') || error.messageKey === 'data.file.unknown')
    return new AirtableError(422, 'INVALID_ATTACHMENT_OBJECT', message(error.messageKey));
  if (/^data\.(value|user|link|file)\./.test(error.messageKey))
    return new AirtableError(
      422,
      'INVALID_VALUE_FOR_COLUMN',
      `Field "${field}" cannot accept the provided value.  ${message(error.messageKey)}`,
    );
  switch (error.code) {
    case 'unauthenticated':
      return authenticationRequired();
    case 'forbidden':
      return modelNotFound();
    case 'not_found':
      return notFound();
    case 'rate_limited':
      return rateLimited();
    case 'payload_too_large':
      return new AirtableError(413, 'REQUEST_TOO_LARGE', 'Request body is too large');
    case 'conflict':
      return new AirtableError(409, 'CONFLICT', message(error.messageKey));
    case 'unavailable':
    case 'setup_required':
      return new AirtableError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
    case 'internal':
      return new AirtableError(500, 'SERVER_ERROR', 'Try again. If the problem persists, contact support.');
    default: {
      const text = message(error.messageKey);
      return invalidRequest(text === error.messageKey ? undefined : text);
    }
  }
}

export function fromAppError(error: AppError): AirtableError {
  const answer = mappedError(error);
  answer.params = error.params;
  answer.conflicts = error.conflicts;
  return answer;
}

/** The error handler for every route under `/v0/`. */
export function airtableErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  let answer: AirtableError;
  if (error instanceof AirtableError) answer = error;
  else if (error instanceof AppError) {
    if (!error.userFault)
      request.log.error({ err: error.cause ?? error, code: error.code }, 'request failed');
    answer = fromAppError(error);
  } else if (error instanceof ZodError) answer = invalidRequest();
  else {
    const status = error.statusCode ?? 500;
    if (status === 413) answer = new AirtableError(413, 'REQUEST_TOO_LARGE', 'Request body is too large');
    else if (status < 500)
      answer = new AirtableError(
        400,
        'INVALID_REQUEST_UNKNOWN',
        'Invalid request: the request could not be parsed.  Send JSON with a Content-Type of application/json.',
      );
    else {
      request.log.error({ err: error }, 'unhandled error');
      answer = new AirtableError(500, 'SERVER_ERROR', 'Try again. If the problem persists, contact support.');
    }
  }
  return reply.status(answer.status).send(answer.body());
}
