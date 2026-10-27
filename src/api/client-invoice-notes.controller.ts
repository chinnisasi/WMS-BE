import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { CurrentSession, TenantSessionGuard } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { ClientInvoiceNoteService, type NoteView } from '../modules/billing/client-invoice-notes';
import type { ClientInvoiceView } from '../modules/billing/client-invoices';
import type { ClientInvoiceDto } from './client-invoices.dto';
import {
  CreateNoteDto,
  InvoiceNotesResponse,
  IssueNoteResponse,
  NotePolicyDto,
  NotePolicyResponse,
  NoteRegisterResponse,
  NoteResponse,
  VoidNoteDto,
  type NoteDto,
} from './client-invoice-notes.dto';
// Bound to @Query() — a value import (the ValidationPipe reads the class).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { NoteRegisterQuery } from './client-invoice-notes.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

const MUTATION_403 =
  'Session belongs to another tenant (permission-denied), or the caller lacks billing.invoice — owner and accountant only (role-denied)';
const READ_403 = 'Session belongs to another tenant (permission-denied), or a client-portal session — a user with a client (role-denied): this is an operator surface';

/**
 * Story 5-6a — credit and debit notes (CGST Act s.34) against an issued
 * client services invoice. Reads are member-open (portal sessions refused);
 * every mutation needs `billing.invoice` (owner + accountant), the policy PUT
 * the owner-only `billing.configure`. Holds no rules — the service owns
 * authority, replay, the locks, the caps and the deadlines; this maps DTOs.
 *
 * Route order: the literal `client-invoice-notes` (the register) is declared
 * before `client-invoice-notes/:noteId` (guide §6, route declaration order).
 */
@ApiTags('billing')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ClientInvoiceNotesController {
  constructor(@Inject(ClientInvoiceNoteService) private readonly notes: ClientInvoiceNoteService) {}

  @Post(':tenantId/client-invoices/:invoiceId/notes')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Drafts a credit or debit note against an issued client invoice (billing.invoice): lines name invoice lines and carry the taxable delta; the tax is the original line’s',
  })
  @ApiBody({ type: CreateNoteDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: NoteResponse, description: 'The draft note' })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing or malformed Idempotency-Key, a malformed invoiceId, a kind or reason outside its vocabulary, a blank or over-long reasonNote, 0 or more than 100 lines, a duplicate line, an amount that is not a positive whole number, settlesDispute on a debit, or an overrideReason on a credit (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such invoice in this tenant, or a line that is not on it (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      'A draft or void invoice (invoice-not-noteable), a debit on a disputed or settled invoice (invoice-not-debitable), settlesDispute on an invoice that is not disputed (invoice-not-disputed), a credit past its s.34(2) date (credit-note-time-barred), a credit over what the invoice line still holds — the `lines` member names each (credit-exceeds-invoice), a debit over its invoice line without an override reason (debit-needs-override), or a concurrent request with the same Idempotency-Key (conflict)',
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async create(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateNoteDto,
  ): Promise<NoteResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(invoiceId, 'invoiceId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.notes.create(
      {
        tenantId,
        actorUserId: session.userId,
        invoiceId,
        kind: dto.kind,
        reason: dto.reason,
        reasonNote: dto.reasonNote,
        settlesDispute: dto.settlesDispute,
        lines: dto.lines.map((line) => ({ invoiceLineId: line.invoiceLineId, amountPaise: line.amountPaise, overrideReason: line.overrideReason })),
      },
      key,
    );
    return { note: toNoteDto(result.note) };
  }

  @Get(':tenantId/client-invoices/:invoiceId/notes')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The credit and debit notes of one client invoice (drafts included), and the document value after its issued notes' })
  @ApiOkResponse({ type: InvoiceNotesResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed invoiceId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client invoice with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async notesOfInvoice(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<InvoiceNotesResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(invoiceId, 'invoiceId');
    const view = await this.notes.notesOfInvoice(tenantId, session.userId, invoiceId);
    return {
      notes: view.notes.map((note) => ({ ...note, totals: { ...note.totals } })),
      netDocument: { ...view.netDocument },
      netDocumentPayable: view.netDocumentPayable,
    };
  }

  @Get(':tenantId/client-invoice-notes')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'The notes register (GSTR-1 CDNR fields): one supplying GSTIN’s issued and void notes over inclusive IST dates, one row per (note, GST rate), oldest first (keyset). JSON only — the web writes the CSV',
  })
  @ApiOkResponse({ type: NoteRegisterResponse })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse('A missing or malformed gstin, from or to, a window over 366 days or inverted, a kind or status outside its vocabulary, a limit outside 1–500 (validation-failed), or a malformed cursor (invalid-cursor)'),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async register(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: NoteRegisterQuery,
  ): Promise<NoteRegisterResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.notes.register(tenantId, session.userId, {
      gstin: query.gstin,
      from: query.from,
      to: query.to,
      kind: query.kind,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { rows: page.rows.map((row) => ({ ...row })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/client-invoice-notes/:noteId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One credit or debit note: its lines, the copied party, the original invoice’s number and date, and a credit’s last day to issue' })
  @ApiOkResponse({ type: NoteResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed noteId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No note with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'noteId', format: 'uuid' })
  async get(@Param('tenantId') tenantId: string, @Param('noteId') noteId: string, @CurrentSession() session: TenantSession): Promise<NoteResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(noteId, 'noteId');
    return { note: toNoteDto(await this.notes.get(tenantId, session.userId, noteId)) };
  }

  @Post(':tenantId/client-invoice-notes/:noteId/issue')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Issues a draft note (billing.invoice): re-checked under the invoice lock, numbered in its own C / D series (FY of the issue) and frozen; a settling credit moves the disputed invoice to settled in the same transaction',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: IssueNoteResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed noteId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No note with this id exists in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      'Not a draft (note-not-draft), the invoice can no longer take it (invoice-not-noteable, invoice-not-debitable, invoice-not-disputed), the creator issuing a credit under the second-approver policy (note-needs-second-approver), past the s.34(2) date (credit-note-time-barred), another credit issued since the draft (credit-exceeds-invoice — `lines` — or note-figures-changed), an e-invoicing GSTIN with a registered client (einvoice-required), the series exhausted (note-series-exhausted), or a concurrent request with the same Idempotency-Key (conflict)',
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'noteId', format: 'uuid' })
  async issue(
    @Param('tenantId') tenantId: string,
    @Param('noteId') noteId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<IssueNoteResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(noteId, 'noteId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.notes.issue({ tenantId, actorUserId: session.userId, noteId }, key);
    return { note: toNoteDto(result.note), ...(result.invoice === undefined ? {} : { invoice: toInvoiceDto(result.invoice) }) };
  }

  @Delete(':tenantId/client-invoice-notes/:noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Discards a draft note (billing.invoice). An issued note is never deleted — void it' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiNoContentResponse({ description: 'Discarded (a replay under the same key answers 204 too)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed noteId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No note with this id — including one already discarded under another key (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The note is not a draft (note-not-draft), or a concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'noteId', format: 'uuid' })
  async discard(
    @Param('tenantId') tenantId: string,
    @Param('noteId') noteId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<void> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(noteId, 'noteId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    await this.notes.discard({ tenantId, actorUserId: session.userId, noteId }, key);
  }

  @Post(':tenantId/client-invoice-notes/:noteId/void')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Voids an issued note (billing.invoice) — a note is required. The void keeps its number and frees its cap' })
  @ApiBody({ type: VoidNoteDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: NoteResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed noteId, or a blank or over-long voidNote (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No note with this id exists in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      'Not issued (note-not-issued), a credit that settled a dispute (note-settles-dispute), past the GSTR-1 due date of its month — the 12th of the next month, IST (note-period-closed), its issuer voiding a credit under the second-approver policy (note-needs-second-approver), or a concurrent request with the same Idempotency-Key (conflict)',
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'noteId', format: 'uuid' })
  async void(
    @Param('tenantId') tenantId: string,
    @Param('noteId') noteId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: VoidNoteDto,
  ): Promise<NoteResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(noteId, 'noteId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.notes.void({ tenantId, actorUserId: session.userId, noteId, voidNote: dto.voidNote }, key);
    return { note: toNoteDto(result.note) };
  }

  @Get(':tenantId/billing/note-policy')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Whether a credit note needs a second person to issue and void it (no setting = required)' })
  @ApiOkResponse({ type: NotePolicyResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async getPolicy(@Param('tenantId') tenantId: string, @CurrentSession() session: TenantSession): Promise<NotePolicyResponse> {
    assertOwnTenant(session, tenantId);
    return this.notes.getPolicy(tenantId, session.userId);
  }

  @Put(':tenantId/billing/note-policy')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sets whether a credit note needs a second person (billing.configure — owner only). Audited' })
  @ApiBody({ type: NotePolicyDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: NotePolicyResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or requireSecondApprover not a boolean (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks billing.configure — owner only (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async putPolicy(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: NotePolicyDto,
  ): Promise<NotePolicyResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return this.notes.putPolicy({ tenantId, actorUserId: session.userId, requireSecondApprover: dto.requireSecondApprover }, key);
  }
}

function toNoteDto(view: NoteView): NoteDto {
  return {
    ...view,
    totals: { ...view.totals },
    party: view.party as NoteDto['party'],
    lines: view.lines.map((line) => ({ ...line })),
  };
}

function toInvoiceDto(view: ClientInvoiceView): ClientInvoiceDto {
  return {
    ...view,
    totals: { ...view.totals },
    gaps: view.gaps.map((gap) => ({ ...gap })),
    warnings: view.warnings.map((warning) => ({ ...warning })),
    party: view.party as ClientInvoiceDto['party'],
    lines: view.lines.map((line) => ({ ...line })),
  };
}

function assertOwnTenant(session: TenantSession, tenantId: string): void {
  if (session.tenantId !== tenantId) {
    throw new ProblemException('permission-denied', 403, 'Session belongs to another tenant', 'The session token tenant does not own this path.');
  }
}

function assertUuidParam(value: string, name: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, `Malformed ${name}`, `${name} must be a uuid (got "${value}").`);
  }
}
