/**
 * The clients module's schema face (story 21-1, AD-6): the table's
 * definition lives in the shared schema file like every other table; this
 * re-export is the module's OWNED view of it — the single import path other
 * files use, so a later story that moves or reshapes the table has one place
 * to re-point.
 */
export {
  CLIENT_STATUSES,
  SELF_CLIENT_CODE,
  clients,
  type Client,
  type ClientStatus,
} from '../../shared/db/schema';