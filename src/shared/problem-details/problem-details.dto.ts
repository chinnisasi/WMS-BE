import { ApiProperty } from '@nestjs/swagger';

/**
 * RFC 9457 problem-details envelope as it appears on the wire. Registered as
 * a schema component so the error contract clients must branch on (code,
 * errors) is visible to OpenAPI codegen, not just to the filter at runtime.
 */
export class ProblemDetailsDto {
  @ApiProperty({ example: 'https://wms.example.com/problems/validation-failed' })
  type!: string;

  @ApiProperty({ example: 'Bad Request' })
  title!: string;

  @ApiProperty({ example: 400 })
  status!: number;

  /** Machine-readable error code — clients branch on this, never on prose. */
  @ApiProperty({ example: 'validation-failed' })
  code!: string;

  @ApiProperty({ required: false, example: 'Echo body must be a JSON object' })
  detail?: string;

  @ApiProperty({ required: false, example: '/api/v1/echo' })
  instance?: string;

  /** Field-level messages when the fault came from validation. */
  @ApiProperty({ required: false, type: [String], example: ['key should not exist'] })
  errors?: string[];
}
