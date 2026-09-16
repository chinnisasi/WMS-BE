import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsString, Length } from 'class-validator';

/**
 * Carriers HTTP surface DTOs (Story 4.6b). Validation lives at the boundary;
 * the command layer re-asserts the invariants it owns (registry membership,
 * per-carrier required fields, the account label).
 *
 * **No response shape in this file carries credential material.** There is no
 * `credential` field on any `…Response` class — not the plaintext, not the
 * sealed blob, not a masked preview. A connection's public face is its id,
 * carrier, label, version and rotation stamps; the secret leaves the system
 * exactly never (AD-15), which is the one invariant this story exists to
 * hold.
 */

export class CarrierCredentialFieldResponse {
  @ApiProperty({ description: 'Wire name inside the `credential` object', example: 'apiToken' })
  name!: string;

  @ApiProperty({ description: 'Human label for the field', example: 'API token' })
  label!: string;

  @ApiProperty({ description: 'A required field absent or blank is a 400' })
  required!: boolean;

  @ApiProperty({ description: 'What the operator should paste here' })
  description!: string;
}

export class CarrierCatalogueEntryResponse {
  @ApiProperty({ description: 'Registry code — the `carrierCode` connect takes', example: 'delhivery' })
  code!: string;

  @ApiProperty({ example: 'Delhivery' })
  displayName!: string;

  @ApiProperty({
    type: [CarrierCredentialFieldResponse],
    description: 'What this carrier needs to be configured with (declaration order)',
  })
  credentialFields!: CarrierCredentialFieldResponse[];
}

export class CarrierCatalogueResponse {
  @ApiProperty({ type: [CarrierCatalogueEntryResponse] })
  items!: CarrierCatalogueEntryResponse[];
}

export class ConnectCarrierDto {
  @ApiProperty({ description: 'A code the adapter registry knows', example: 'delhivery' })
  @IsString()
  @Length(1, 64)
  carrierCode!: string;

  @ApiProperty({ description: "The operator's name for this account", example: 'Delhivery — Mumbai' })
  @IsString()
  @Length(1, 100)
  accountLabel!: string;

  @ApiProperty({
    description:
      'The carrier credential fields, as declared by GET /carriers for this code. Write-only: sealed under CARRIER_ENCRYPTION_KEY and never returned, listed or logged.',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { apiToken: 'dl_live_…', clientName: 'PRIYA SPICES' },
  })
  @IsObject()
  credential!: Record<string, string>;
}

export class RotateCarrierCredentialDto {
  @ApiProperty({
    description:
      'The replacement credential fields for this connection’s carrier. The connection id is unchanged; credentialVersion increments.',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { apiToken: 'dl_live_rotated_…', clientName: 'PRIYA SPICES' },
  })
  @IsObject()
  credential!: Record<string, string>;
}

export class CarrierConnectionResponse {
  @ApiProperty({ format: 'uuid', description: 'The stable handle rotation preserves' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ example: 'delhivery' })
  carrierCode!: string;

  @ApiProperty({ description: 'The registry display name for the code', example: 'Delhivery' })
  carrierName!: string;

  @ApiProperty({ example: 'Delhivery — Mumbai' })
  accountLabel!: string;

  @ApiProperty({ description: '1 at connect, +1 per rotation', example: 1 })
  credentialVersion!: number;

  @ApiProperty({ format: 'uuid' })
  connectedBy!: string;

  // `type: String` is load-bearing on the nullable fields: the swc decorator
  // metadata for a `string | null` union is `Object`, which @nestjs/swagger
  // would emit as "type": "object" — diverging from the bun-served document
  // the openapi:export script commits (the api.spec.ts drift guard).
  @ApiProperty({ type: String, nullable: true })
  rotatedAt!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  rotatedBy!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class CarrierConnectionListResponse {
  @ApiProperty({ type: [CarrierConnectionResponse] })
  items!: CarrierConnectionResponse[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
