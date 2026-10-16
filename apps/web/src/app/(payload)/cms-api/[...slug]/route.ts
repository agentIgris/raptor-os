import config from "@payload-config";
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from "@payloadcms/next/routes";

/**
 * Payload REST API at `/cms-api/*`.
 *
 * Deliberately NOT `/api/*`: that namespace belongs to Better Auth
 * (`/api/auth/*`) and the health probes, and the proxy CSP matcher already
 * excludes `api/*` from document policies. Every collection in this CMS
 * denies by default (see `@raptor/cms` access rules), so these routes expose
 * only what an access function explicitly allows.
 */
export const GET = REST_GET(config);
export const POST = REST_POST(config);
export const DELETE = REST_DELETE(config);
export const PATCH = REST_PATCH(config);

export const PUT = REST_PUT(config);
export const OPTIONS = REST_OPTIONS(config);
