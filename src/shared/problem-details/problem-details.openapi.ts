import { getSchemaPath } from '@nestjs/swagger';
import { ProblemDetailsDto } from './problem-details.dto';

/**
 * OpenAPI response fragment for RFC 9457 error responses — the exact wire
 * format ProblemDetailsFilter emits (`application/problem+json`). Spread into
 * `@ApiResponse` so generated clients model the universal error contract.
 */
export function problemJsonResponse(description: string): {
  description: string;
  content: Record<string, { schema: { $ref: string } }>;
} {
  return {
    description,
    content: {
      'application/problem+json': { schema: { $ref: getSchemaPath(ProblemDetailsDto) } },
    },
  };
}