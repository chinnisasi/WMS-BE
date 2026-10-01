import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Controller, HttpCode, HttpStatus, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { ChannelsFacade } from '../modules/channels/channels.facade';
import { channelAdapter } from '../modules/channels/channel-registry';
import type {
  ChannelAdapter,
  ChannelWebhookEndpoint,
  ChannelWebhookVerification,
} from '../modules/channels/channel-registry';
import {
  channelConnectionNotFound,
  channelWebhookUnconfigured,
  invalidUuidParam,
} from '../modules/channels/channels.errors';

/**
 * The channel webhook surface (story 7.2, rows 1-2, RD-5/RD-9). Guardless
 * by construction — there is NO APP_GUARD in this app (grep-verified) and
 * per-route guards stay off here deliberately: the provider's request
 * carries no session, its AUTHORITY is its signature.
 *
 * The per-delivery order (T2, verify-first):
 *
 *   connection resolve (by id + tenant + provider path — unknown/foreign
 *   → 404, naming nothing) → registry's webhook declaration (missing → 501
 *   verbatim, BEFORE any credential is touched) → open the sealed
 *   credential in process → HMAC over the RAW body (never the parsed one —
 *   re-serialization would not re-hash) + the TOPIC BINDING (the topic
 *   header must equal THE ENDPOINT's declared topic — a captured
 *   orders/create delivery replayed against cancellations fails here, the
 *   review's highest-severity fix) → parse arm → the ingest command.
 *
 * The RAW body arrives as `req.rawBody` (app.factory's `rawBody: true`) —
 * deliberately NOT through `@Body()`: the global ValidationPipe sees every
 * route and skips only non-class metatypes, so a decorated DTO here would
 * die on `forbidNonWhitelisted` before verification could run.
 *
 * Every refusal answers problem-details. The verification-failure class
 * (bad signature, missing/unopenable secret, topic mismatch) is ALWAYS 401
 * with an EMPTY detail — content is never named — and meters the coarse
 * rate-limited `verification-failed` row (RD-5/bl-5: visible same-day,
 * content-free). Idempotency-Key is NOT a webhook input — the ingest
 * command mints its own per-delivery ULID (RD-9).
 */
/** The orders endpoint's response (row 1). */
export class ChannelWebhookOrderResponse {
  @ApiProperty({ enum: ['accepted', 'backordered', 'replayed'] })
  outcome!: 'accepted' | 'backordered' | 'replayed';

  @ApiProperty({ format: 'uuid', description: 'The order this delivery resolved to (accepted, backordered and replayed alike)' })
  orderId!: string;
}

/** The cancellations endpoint's response (row 2). */
export class ChannelWebhookCancellationResponse {
  @ApiProperty({ enum: ['released', 'ignored'] })
  outcome!: 'released' | 'ignored';
}

@ApiTags('webhooks')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class WebhooksController {
  constructor(@Inject(ChannelsFacade) private readonly channels: ChannelsFacade) {}

  @Post(':tenantId/webhooks/channels/:provider/:connectionId/orders')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "A sales channel's order event (signature-verified, no session) — normalizes, maps and accepts through THE order path; the same payload twice resolves to the same order",
  })
  @ApiOkResponse({ type: ChannelWebhookOrderResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A verified body that carries no mappable order shape (validation-failed — ordered AFTER verification)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Signature invalid, the signing secret absent/unopenable, or the topic does not bind this endpoint (webhook-signature-invalid, empty detail)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('The connection’s ingest actor has lost orders.manage (order-actor-unprivileged) — NACK; retry heals after a reconnect') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown or foreign connection (not-found), or an unregistered provider') })
  @ApiResponse({ status: 409, ...problemJsonResponse('backorder_policy reject and some line could not fully reserve (order-backorder-rejected) — nothing written, every hold released') })
  @ApiResponse({ status: 422, ...problemJsonResponse('A divergent payload on a known order ref (order-source-conflict), no ingest warehouse set (ingest-warehouse-unset), or config referencing deleted master data (ingest-config-invalid)') })
  @ApiResponse({ status: 501, ...problemJsonResponse('The provider declares no webhook transport on this deployment (channel-transport-unconfigured)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The grant store failed closed (reservation-store-unavailable) — nothing written, the channel retries') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'The owning tenant path' })
  @ApiParam({ name: 'provider', description: 'The channel provider code' })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  async ingestOrder(
    @Param('tenantId') tenantId: string,
    @Param('provider') provider: string,
    @Param('connectionId') connectionId: string,
    @Req() request: Request,
  ): Promise<ChannelWebhookOrderResponse> {
    const verified = await this.verifyDelivery(tenantId, provider, connectionId, 'orders', request);
    const parsed = verified.adapter.webhook!.parseOrder(verified.body);
    if (parsed === null) {
      await this.channels.recordIngestParseRefused(tenantId, connectionId);
      throw webhookValidationFailed();
    }
    const result = await this.channels.ingestOrderDelivery({
      tenantId,
      connectionId,
      parsed,
    });
    return { outcome: result.outcome, orderId: result.orderId };
  }

  @Post(':tenantId/webhooks/channels/:provider/:connectionId/cancellations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "A sales channel's cancellation event (signature-verified, no session) — releases an accepted order's holds; past-accepted or already-cancelled orders ignore it",
  })
  @ApiOkResponse({ type: ChannelWebhookCancellationResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A verified body that carries no cancellable shape (validation-failed — ordered AFTER verification)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Signature invalid, the signing secret absent/unopenable, or the topic does not bind this endpoint (webhook-signature-invalid, empty detail)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('The connection’s ingest actor has lost orders.manage (order-actor-unprivileged)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown or foreign connection (not-found), or an unregistered provider') })
  @ApiResponse({ status: 501, ...problemJsonResponse('The provider declares no webhook transport on this deployment (channel-transport-unconfigured)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('No order for this connection carries the ref yet (cancellation-unresolved — NACK; the retry lands after the create commits), or the grant store failed closed') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'The owning tenant path' })
  @ApiParam({ name: 'provider', description: 'The channel provider code' })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  async ingestCancellation(
    @Param('tenantId') tenantId: string,
    @Param('provider') provider: string,
    @Param('connectionId') connectionId: string,
    @Req() request: Request,
  ): Promise<ChannelWebhookCancellationResponse> {
    const verified = await this.verifyDelivery(tenantId, provider, connectionId, 'cancellations', request);
    const parsed = verified.adapter.webhook!.parseCancellation(verified.body);
    if (parsed === null) {
      throw webhookValidationFailed();
    }
    const result = await this.channels.ingestCancellationDelivery({
      tenantId,
      connectionId,
      parsed,
    });
    return { outcome: result.outcome };
  }

  /**
   * The verify-first preamble shared by both endpoints. Answers the adapter
   * + the PARSED body (JSON.parse of the raw body — a non-JSON body is a
   * 400 AFTER verification, so tampering never learns the body was read).
   * Everything it throws is refusal-shaped; the verification-failure class
   * meters coarse before throwing.
   */
  private async verifyDelivery(
    tenantId: string,
    provider: string,
    connectionId: string,
    endpoint: ChannelWebhookEndpoint,
    request: Request,
  ): Promise<{ adapter: ChannelAdapter; body: Record<string, unknown> }> {
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(connectionId)) {
      throw invalidUuidParam(!UUID_RE.test(tenantId) ? 'tenantId' : 'connectionId', tenantId);
    }
    // Connection resolve first (404 names nothing): the id must exist in
    // THIS tenant AND the provider path must match its own. The FACE
    // carries the provider + the OPENED signing secret — the sealed blob
    // never crosses into `src/api` (the carriers 4.6b pin); the envelope
    // stays channels-module-owned.
    const face = await this.channels.webhookDeliveryFace(tenantId, connectionId);
    if (face === null || face.provider !== provider) {
      throw channelConnectionNotFound();
    }
    const adapter = channelAdapter(provider);
    const declaration = adapter?.webhook;
    if (adapter === undefined) {
      // An unregistered provider code has no connection, but a KNOWN
      // provider code is the honest miss; either way this is unmapable
      // transport — the 404 keeps the posture (the connection does not
      // answer for a provider it is not).
      throw channelConnectionNotFound();
    }
    if (declaration === undefined) {
      // RD-5/RD-6: the 501 gate, BEFORE any credential is touched.
      throw channelWebhookUnconfigured(provider);
    }

    // The signing secret (request-scoped plaintext — never logged, never in
    // any response). Absent or unopenable is the SAME 401 class (bl-9: not
    // silent — the coarse meter carries the misconfiguration's visibility).
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;
    if (
      rawBody === undefined ||
      !verifyWebhookSignature(
        declaration.verification,
        face.webhookSecret ?? '',
        rawBody,
        request.headers[declaration.verification.header.toLowerCase()],
      )
    ) {
      await this.channels.recordIngestVerificationRefused(tenantId, connectionId);
      throw webhookSignatureInvalid();
    }
    // The TOPIC BINDING (RD-5): the provider's topic header must equal THIS
    // endpoint's declared topic — the cross-endpoint replay stop.
    const topicHeader = request.headers[declaration.verification.topicHeader.toLowerCase()];
    if (
      typeof topicHeader !== 'string' ||
      topicHeader !== declaration.topics[endpoint]
    ) {
      await this.channels.recordIngestVerificationRefused(tenantId, connectionId);
      throw webhookSignatureInvalid();
    }

    // Parse AFTER verification: the 400 for a shaped-but-unmappable body
    // never runs for a tampered one. A non-JSON body throws here.
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw webhookValidationFailed();
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw webhookValidationFailed();
    }
    return { adapter, body: body as Record<string, unknown> };
  }

}

/**
 * 401 `webhook-signature-invalid` — the verification-failure class's ONE
 * answer: EMPTY detail, always. No header value, no body content, no
 * connection state, ever.
 */
function webhookSignatureInvalid(): ProblemException {
  return new ProblemException('webhook-signature-invalid', 401, 'Webhook signature invalid', '');
}

/** 400 `validation-failed` — a verified body that carries no mappable shape. */
function webhookValidationFailed(): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    'Webhook body is not mappable',
    'The verified payload carries none of the expected shape for this endpoint — nothing was written.',
  );
}

/**
 * The declaration-driven signature verification (RD-5): HMAC-SHA256 over
 * the raw body in the declared encoding, constant-time compared. Today the
 * frozen scheme is `hmac-sha256`; a future scheme that is NOT hmac-sha256
 * fails CLOSED here (the registry would come with its arm).
 */
function verifyWebhookSignature(
  verification: ChannelWebhookVerification,
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | string[] | undefined,
): boolean {
  if (verification.scheme !== 'hmac-sha256') {
    // Fail closed: a scheme this build can no-op would otherwise verify
    // nothing at all. The channel-http story adds arms WITH their code.
    throw new ProblemException(
      'webhook-signature-invalid',
      401,
      'Webhook signature scheme not supported',
      '',
    );
  }
  if (
    secret === '' ||
    signatureHeader === undefined ||
    Array.isArray(signatureHeader) ||
    signatureHeader === ''
  ) {
    return false;
  }
  const digestEncoding = verification.encoding === 'hex' ? 'hex' : 'base64';
  const expected = createHmac('sha256', secret).update(rawBody).digest(digestEncoding);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}