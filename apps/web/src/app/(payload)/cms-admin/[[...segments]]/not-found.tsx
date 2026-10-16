/**
 * 404 inside the CMS admin route group.
 *
 * Plain by design: Payload renders its own in-admin missing states; this only
 * covers URLs under `/cms-admin` that match no admin view at all.
 */
const CmsAdminNotFound = (): React.JSX.Element => <p>CMS page not found.</p>;

export default CmsAdminNotFound;
