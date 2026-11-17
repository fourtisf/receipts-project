/** Shown on legal templates until a lawyer has reviewed them. */
export function LegalBanner() {
  return (
    <p className="notice warn mb-8" role="note">
      <strong className="font-semibold">Template, not yet reviewed by a lawyer.</strong> This text is a
      placeholder describing how the product works. It must be reviewed and completed (operator entity,
      jurisdiction, contact) before launch.
    </p>
  );
}
