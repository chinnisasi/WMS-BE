import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsObject, IsString, Length, Matches } from 'class-validator';

/**
 * Devices HTTP surface DTOs (Story 3.2). Validation lives at the boundary;
 * the command layer re-asserts the invariants it owns.
 */
export class MintEnrollmentCodeDto {}

export class MintEnrollmentCodeResponse {
  @ApiProperty({
    description: 'The one-time enrollment code (raw — shown once; 43-char base64url)',
    example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  })
  code!: string;

  @ApiProperty({ description: 'ISO-8601 instant the code expires (15-minute TTL)' })
  expiresAt!: string;
}

export class EnrollDeviceDto {
  @ApiProperty({
    description: 'The one-time enrollment code minted in web Settings (43-char base64url — sha256-hashed server-side)',
    example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  })
  @IsString()
  @Length(43, 43)
  code!: string;

  @ApiProperty({ description: 'Human-readable device label (1-100 characters)', example: 'Dock scanner 1' })
  @IsString()
  @Length(1, 100)
  label!: string;

  @ApiProperty({ description: 'The badge-in PIN (4-6 digits, set during enrollment)', example: '1234' })
  @IsString()
  @Matches(/^[0-9]{4,6}$/, { message: 'pin must be 4-6 digits' })
  pin!: string;
}

export class EnrolledDeviceResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty()
  label!: string;
}

export class EnrollDeviceResponse {
  @ApiProperty({ type: EnrolledDeviceResponse })
  device!: EnrolledDeviceResponse;

  @ApiProperty({ description: 'The device-bound credential (30-day TTL, server-checked)' })
  deviceToken!: string;

  @ApiProperty()
  expiresInSeconds!: number;

  @ApiProperty({
    description:
      'The offline-store key, sealed under DEVICE_ENCRYPTION_KEY (AES-256-GCM envelope) — unwrap once into the device keychain',
  })
  offlineStoreKeySealed!: string;
}

export class BadgeInDto {
  @ApiProperty({ description: 'The badge-in operator (email)', format: 'email' })
  @IsEmail()
  operatorEmail!: string;

  @ApiProperty({ description: 'The operator badge-in PIN (4-6 digits)' })
  @IsString()
  @Matches(/^[0-9]{4,6}$/, { message: 'pin must be 4-6 digits' })
  pin!: string;
}

export class BadgeInOperatorResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ enum: ['owner', 'ops_manager', 'operator', 'accountant'] })
  role!: string;
}

export class BadgeInDeviceResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  label!: string;
}

export class BadgeInResponse {
  @ApiProperty({ description: 'The revocable operator-bound device session token' })
  accessToken!: string;

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty()
  expiresInSeconds!: number;

  @ApiProperty({ type: BadgeInOperatorResponse })
  operator!: BadgeInOperatorResponse;

  @ApiProperty({ type: BadgeInDeviceResponse })
  device!: BadgeInDeviceResponse;
}

export class DeviceResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  // `type: String` is load-bearing on the nullable fields: the swc decorator
  // metadata for a `string | null` union is `Object`, which @nestjs/swagger
  // would emit as "type": "object" — diverging from the bun-served document
  // the openapi:export script commits (the api.spec.ts drift guard).
  @ApiProperty({ type: String, nullable: true })
  label!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  operatorUserId!: string | null;

  @ApiProperty({ type: String, format: 'email', nullable: true })
  operatorEmail!: string | null;

  @ApiProperty({ enum: ['active', 'revoked'] })
  status!: 'active' | 'revoked';

  @ApiProperty()
  wipeFlag!: boolean;

  @ApiProperty({ type: String, nullable: true })
  enrolledAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lastSeenAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  revokedAt!: string | null;

  @ApiProperty()
  createdAt!: string;
}

export class DeviceListResponse {
  @ApiProperty({ type: [DeviceResponse] })
  items!: DeviceResponse[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class DeviceSelfTestEchoDto {
  @ApiProperty({ description: 'The queued self-test op payload the device replayed' })
  @IsObject()
  payload!: Record<string, unknown>;
}

export class DeviceSelfTestEchoResponse {
  @ApiProperty({ format: 'uuid' })
  deviceId!: string;

  @ApiProperty({ format: 'uuid' })
  operatorUserId!: string;

  @ApiProperty()
  echoed!: Record<string, unknown>;

  @ApiProperty({ description: 'Server receive instant (ISO-8601 UTC)' })
  receivedAt!: string;
}